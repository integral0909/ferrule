import {
  addMetricValues,
  cloneMetricValue,
  exponentialHistogramToHistogram,
  FerruleError,
  seriesKey,
  type MetricEvent,
  type MetricValue,
} from '@ferrule/core';
import { ProtoWriter } from '@ferrule/codecs';

/**
 * Prometheus remote-write's `WriteRequest` protobuf message (the stable `prompb` v1 shape:
 * `TimeSeries { labels, samples }`, `Label { name, value }`, `Sample { value, timestamp }`),
 * encoded with the codecs package's hand-written `ProtoWriter`, plus the metric → series
 * conversion remote write needs: counters/gauges map directly, histograms expand into
 * `_bucket`/`_sum`/`_count` series (bucket counts made cumulative, per Prometheus convention),
 * exponential histograms are first converted to explicit buckets with core's
 * `exponentialHistogramToHistogram` (remote write has no exponential-scale representation) and
 * then expand the same way, summaries expand into per-quantile series plus `_sum`/`_count`, and
 * incremental metrics are accumulated into the running absolute totals remote write transmits,
 * bounded by a staleness window so a series that stops reporting is not accumulated into
 * forever.
 */

export interface RemoteWriteSeries {
  /** Label pairs, sorted by name (`__name__` sorts first). */
  readonly labels: readonly (readonly [string, string])[];
  readonly samples: readonly { readonly value: number; readonly timestampMs: number }[];
}

export function encodeWriteRequest(series: readonly RemoteWriteSeries[]): Uint8Array {
  const writer = new ProtoWriter();
  for (const ts of series) {
    writer.writeMessage(1, (w) => {
      for (const [name, value] of ts.labels) {
        w.writeMessage(1, (lw) => {
          lw.writeString(1, name);
          lw.writeString(2, value);
        });
      }
      for (const sample of ts.samples) {
        w.writeMessage(2, (sw) => {
          sw.writeDouble(1, sample.value);
          sw.writeInt64(2, BigInt(Math.trunc(sample.timestampMs)));
        });
      }
    });
  }
  return writer.finish();
}

function labelSet(
  name: string,
  tags: ReadonlyMap<string, string>,
  extra?: Readonly<Record<string, string>>,
): (readonly [string, string])[] {
  const labels: [string, string][] = [['__name__', name]];
  for (const [k, v] of tags) labels.push([k, v]);
  if (extra !== undefined) for (const [k, v] of Object.entries(extra)) labels.push([k, v]);
  labels.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return labels;
}

function formatLabelFloat(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

/** Raised when a `MetricValue` type has no Prometheus remote-write representation (`set`,
 * `distribution`) — the caller should treat the offending event as a permanent, per-event failure
 * rather than aborting the whole batch. */
export class UnsupportedMetricTypeError extends FerruleError {
  constructor(type: string) {
    super(
      'E_PROM_REMOTE_WRITE_UNSUPPORTED',
      `metric value type ${JSON.stringify(type)} has no Prometheus remote-write representation`,
    );
    this.name = 'UnsupportedMetricTypeError';
  }
}

/** Expands one metric event's (already-accumulated, absolute) value into one or more remote-write
 * time series. */
export function expandMetricToSeries(
  event: MetricEvent,
  value: MetricValue,
  timestampMs: number,
): RemoteWriteSeries[] {
  const name = event.series.name;
  const tags = event.series.tags;
  switch (value.type) {
    case 'counter':
    case 'gauge':
      return [{ labels: labelSet(name, tags), samples: [{ value: value.value, timestampMs }] }];
    case 'histogram': {
      const out: RemoteWriteSeries[] = [];
      let cumulative = 0;
      for (const bucket of value.buckets) {
        cumulative += bucket.count;
        out.push({
          labels: labelSet(`${name}_bucket`, tags, { le: formatLabelFloat(bucket.upperLimit) }),
          samples: [{ value: cumulative, timestampMs }],
        });
      }
      out.push({
        labels: labelSet(`${name}_bucket`, tags, { le: '+Inf' }),
        samples: [{ value: value.count, timestampMs }],
      });
      out.push({
        labels: labelSet(`${name}_sum`, tags),
        samples: [{ value: value.sum, timestampMs }],
      });
      out.push({
        labels: labelSet(`${name}_count`, tags),
        samples: [{ value: value.count, timestampMs }],
      });
      return out;
    }
    case 'exponentialHistogram':
      return expandMetricToSeries(event, exponentialHistogramToHistogram(value), timestampMs);
    case 'summary': {
      const out: RemoteWriteSeries[] = value.quantiles.map((q) => ({
        labels: labelSet(name, tags, { quantile: formatLabelFloat(q.quantile) }),
        samples: [{ value: q.value, timestampMs }],
      }));
      out.push({
        labels: labelSet(`${name}_sum`, tags),
        samples: [{ value: value.sum, timestampMs }],
      });
      out.push({
        labels: labelSet(`${name}_count`, tags),
        samples: [{ value: value.count, timestampMs }],
      });
      return out;
    }
    case 'set':
    case 'distribution':
      throw new UnsupportedMetricTypeError(value.type);
  }
}

// -----------------------------------------------------------------------------------------------
// Incremental -> absolute accumulation, with a staleness bound
// -----------------------------------------------------------------------------------------------

interface SeriesState {
  value: MetricValue;
  lastWallMs: number;
}

/**
 * Accumulates `incremental` metric values into a running absolute total per series (identified by
 * {@link seriesKey}), the shape Prometheus remote write transmits. `absolute` values, and value
 * types accumulation is not defined for (`summary`; quantiles are not additive), pass through
 * unchanged. If a series has not been observed for longer than `staleBoundMs`, the next
 * observation restarts accumulation from that value instead of adding to a now-meaningless total
 * (guarding against, for example, a long gap making an old base value wrap or overflow oddly).
 */
export class MetricAccumulator {
  private readonly state = new Map<string, SeriesState>();

  constructor(private readonly staleBoundMs: number = 5 * 60_000) {}

  /** Folds `event` into its series' running total (if incremental) and returns the value to
   * publish for it right now. */
  accumulate(event: MetricEvent, nowMs: number): MetricValue {
    if (
      event.metricKind === 'absolute' ||
      event.value.type === 'summary' ||
      event.value.type === 'set'
    ) {
      this.state.set(seriesKey(event.series), {
        value: cloneMetricValue(event.value),
        lastWallMs: nowMs,
      });
      return event.value;
    }
    const key = seriesKey(event.series);
    const prior = this.state.get(key);
    const stale = prior === undefined || nowMs - prior.lastWallMs > this.staleBoundMs;
    const combined = stale ? undefined : addMetricValues(prior.value, event.value);
    const value = combined ?? event.value;
    this.state.set(key, { value: cloneMetricValue(value), lastWallMs: nowMs });
    return value;
  }

  /** Series keys not observed within `staleBoundMs` of `nowMs`, removing them from tracked state.
   * Callers that want to emit an explicit Prometheus staleness marker (`NaN`) can do so for each
   * returned key; this accumulator itself only tracks state, it does not emit samples. */
  expireStale(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [key, entry] of this.state) {
      if (nowMs - entry.lastWallMs > this.staleBoundMs) {
        expired.push(key);
        this.state.delete(key);
      }
    }
    return expired;
  }

  get size(): number {
    return this.state.size;
  }
}
