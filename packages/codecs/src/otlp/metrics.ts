import {
  createMetadata,
  FerruleError,
  LimitExceededError,
  MetricEvent,
  Timestamp,
  type Bucket,
  type MetricKind,
  type MetricValue,
  type Quantile,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { forEachField } from '../proto/index.js';
import { ProtoWriter } from '../proto/writer.js';
import { stringifyValue } from '../value_text.js';
import {
  decodeAttributeInto,
  decodeResource,
  decodeScope,
  type OtlpDecodeOptions,
  readOptionalTimestamp,
  resolveDecodeOptions,
  writeAttributes,
  writeTimestamp,
} from './common.js';

/** OTLP `AggregationTemporality` values. Plain numeric constants (not a TypeScript enum) so
 * comparisons below are ordinary `number` comparisons, not narrowed enum-literal comparisons. */
const TEMPORALITY_DELTA = 1;
const TEMPORALITY_CUMULATIVE = 2;

/**
 * Mapping between OTLP `Metric` data points and {@link MetricEvent}s. One OTLP `Metric` expands
 * to one `MetricEvent` per data point (core's metric model is per-series, per-point).
 *
 * - `Gauge` data points become `{ type: 'gauge' }`, kind `absolute`.
 * - `Sum` data points become `counter` when `is_monotonic`, `gauge` otherwise; kind is
 *   `incremental` for delta temporality and `absolute` for cumulative (or unspecified, treated as
 *   cumulative).
 * - `Histogram` data points become `{ type: 'histogram' }`: `bucket_counts` has one more entry
 *   than `explicit_bounds` (the implicit `+Inf` overflow bucket), which matches how core
 *   histograms already represent overflow (`count - sum(bucket.count)`), so the last
 *   `bucket_counts` entry is dropped and `count`/`sum` are carried over directly.
 * - `ExponentialHistogram` data points are converted to explicit buckets: with `base =
 *   2^(2^-scale)`, bucket `i` of the positive range covers `(base^i, base^(i+1)]` and becomes a
 *   core bucket with `upperLimit = base^(i+1)`; the negative range is mirrored (`upperLimit =
 *   -base^i`, buckets emitted from the most-negative index down to the least); the zero bucket
 *   (if `zero_count > 0`) becomes one more bucket at `upperLimit = zero_threshold`. This is lossy
 *   (buckets replace an implicit exponential scale with explicit boundaries) but round-trips
 *   through core's histogram operations like any other histogram.
 * - `Summary` data points become `{ type: 'summary' }`, kind always `absolute` (OTLP summaries
 *   have no temporality).
 *
 * Attributes: since `MetricEvent.series.tags` is `Map<string, string>`, `Resource` attributes,
 * `InstrumentationScope` name/version/attributes (under an `otel.scope.*` prefix), and the data
 * point's own attributes are all stringified (see {@link stringifyAttributeValue}) and merged into
 * `tags`, with more specific values overriding less specific ones in that order. `description` and
 * `unit` have no equivalent field on `MetricEvent` and are dropped.
 *
 * Encoding is the mapping's inverse for `counter`, `gauge`, `histogram`, and `summary` values. An
 * `absolute` gauge encodes as `Gauge` (which has no temporality); an `incremental` gauge has no
 * home there, so it encodes as a non-monotonic, delta `Sum` instead, which round-trips the kind.
 * `set` and `distribution` values have no OTLP representation and raise
 * `E_OTLP_UNSUPPORTED_METRIC_TYPE`; convert them (e.g. with `samplesToHistogram`) before encoding.
 * Encoding never reconstructs resource/scope (core's `MetricEvent` does not carry them): output is
 * always one empty `Resource` and one nameless `InstrumentationScope`.
 */
export function decodeExportMetricsServiceRequest(
  bytes: Uint8Array,
  options: OtlpDecodeOptions = {},
): MetricEvent[] {
  const resolved = resolveDecodeOptions(options);
  const events: MetricEvent[] = [];
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    decodeResourceMetrics(r.readBytes(), resolved, events);
  });
  return events;
}

function decodeResourceMetrics(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  let resourceTags: Map<string, string> = new Map();
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        resourceTags = tagsFromAttributes(decodeResource(r.readBytes(), options));
        break;
      case 2:
        decodeScopeMetrics(r.readBytes(), resourceTags, options, out);
        break;
      default:
        r.skipValue(wireType);
    }
  });
}

function decodeScopeMetrics(
  bytes: Uint8Array,
  resourceTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  let scopeTags = new Map<string, string>();
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1: {
        const scope = decodeScope(r.readBytes(), options);
        scopeTags = new Map<string, string>();
        if (scope.name !== '') scopeTags.set('otel.scope.name', scope.name);
        if (scope.version !== undefined) scopeTags.set('otel.scope.version', scope.version);
        for (const [k, v] of tagsFromAttributes(scope.attributes)) scopeTags.set(k, v);
        break;
      }
      case 2: {
        const baseTags = new Map([...resourceTags, ...scopeTags]);
        decodeMetric(r.readBytes(), baseTags, options, out);
        break;
      }
      default:
        r.skipValue(wireType);
    }
  });
}

function decodeMetric(
  bytes: Uint8Array,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  let name = '';
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        name = r.readString();
        break;
      case 5:
        decodeGauge(r.readBytes(), name, baseTags, options, out);
        break;
      case 7:
        decodeSum(r.readBytes(), name, baseTags, options, out);
        break;
      case 9:
        decodeHistogram(r.readBytes(), name, baseTags, options, out);
        break;
      case 10:
        decodeExponentialHistogram(r.readBytes(), name, baseTags, options, out);
        break;
      case 11:
        decodeSummary(r.readBytes(), name, baseTags, options, out);
        break;
      default:
        r.skipValue(wireType);
    }
  });
}

interface RawNumberPoint {
  tags: Map<string, string>;
  startTime: Timestamp | undefined;
  time: Timestamp | undefined;
  value: number;
}

function decodeNumberDataPoint(
  bytes: Uint8Array,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
): RawNumberPoint {
  const attributes: ValueMap = new Map();
  let startTime: Timestamp | undefined;
  let time: Timestamp | undefined;
  let value = 0;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 7:
        decodeAttributeInto(attributes, r.readBytes(), options);
        break;
      case 2:
        startTime = readOptionalTimestamp(r);
        break;
      case 3:
        time = readOptionalTimestamp(r);
        break;
      case 4:
        value = r.readDouble();
        break;
      case 6:
        value = Number(r.readSFixed64());
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return { tags: mergeTags(baseTags, attributes), startTime, time, value };
}

function decodeGauge(
  bytes: Uint8Array,
  name: string,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    const dp = decodeNumberDataPoint(r.readBytes(), baseTags, options);
    out.push(buildEvent(name, dp.tags, 'absolute', { type: 'gauge', value: dp.value }, dp));
  });
}

function decodeSum(
  bytes: Uint8Array,
  name: string,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  let temporality = 0;
  let isMonotonic = false;
  const points: RawNumberPoint[] = [];
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        points.push(decodeNumberDataPoint(r.readBytes(), baseTags, options));
        break;
      case 2:
        temporality = r.readInt32();
        break;
      case 3:
        isMonotonic = r.readBool();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  const kind: MetricKind = temporality === TEMPORALITY_DELTA ? 'incremental' : 'absolute';
  const valueType = isMonotonic ? 'counter' : 'gauge';
  for (const dp of points) {
    const value: MetricValue = { type: valueType, value: dp.value };
    out.push(buildEvent(name, dp.tags, kind, value, dp));
  }
}

function decodeHistogram(
  bytes: Uint8Array,
  name: string,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  let temporality = 0;
  const points: {
    attrs: ValueMap;
    startTime?: Timestamp | undefined;
    time?: Timestamp | undefined;
    count: number;
    sum: number;
    buckets: Bucket[];
  }[] = [];
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        points.push(decodeHistogramDataPoint(r.readBytes(), options));
        break;
      case 2:
        temporality = r.readInt32();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  const kind: MetricKind = temporality === TEMPORALITY_DELTA ? 'incremental' : 'absolute';
  for (const dp of points) {
    const tags = mergeTags(baseTags, dp.attrs);
    const value: MetricValue = {
      type: 'histogram',
      buckets: dp.buckets,
      count: dp.count,
      sum: dp.sum,
    };
    out.push(buildEvent(name, tags, kind, value, dp));
  }
}

function decodeHistogramDataPoint(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
) {
  const attrs: ValueMap = new Map();
  let startTime: Timestamp | undefined;
  let time: Timestamp | undefined;
  let count = 0;
  let sum = 0;
  let bucketCounts: bigint[] = [];
  let explicitBounds: number[] = [];
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 9:
        decodeAttributeInto(attrs, r.readBytes(), options);
        break;
      case 2:
        startTime = readOptionalTimestamp(r);
        break;
      case 3:
        time = readOptionalTimestamp(r);
        break;
      case 4:
        count = Number(r.readFixed64());
        break;
      case 5:
        sum = r.readDouble();
        break;
      case 6:
        bucketCounts = r.readPacked((ir) => ir.readFixed64());
        checkCollectionSize(bucketCounts.length, options);
        break;
      case 7:
        explicitBounds = r.readPacked((ir) => ir.readDouble());
        checkCollectionSize(explicitBounds.length, options);
        break;
      default:
        r.skipValue(wireType);
    }
  });
  const buckets: Bucket[] = explicitBounds.map((upperLimit, i) => ({
    upperLimit,
    count: Number(bucketCounts[i] ?? 0n),
  }));
  return { attrs, startTime, time, count, sum, buckets };
}

function decodeExponentialHistogram(
  bytes: Uint8Array,
  name: string,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  let temporality = 0;
  const points: ReturnType<typeof decodeExponentialHistogramDataPoint>[] = [];
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        points.push(decodeExponentialHistogramDataPoint(r.readBytes(), options));
        break;
      case 2:
        temporality = r.readInt32();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  const kind: MetricKind = temporality === TEMPORALITY_DELTA ? 'incremental' : 'absolute';
  for (const dp of points) {
    const tags = mergeTags(baseTags, dp.attrs);
    const buckets = expandExponentialBuckets(dp, options);
    const value: MetricValue = { type: 'histogram', buckets, count: dp.count, sum: dp.sum };
    out.push(buildEvent(name, tags, kind, value, dp));
  }
}

interface ExpBuckets {
  offset: number;
  counts: bigint[];
}

function decodeExponentialHistogramDataPoint(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
) {
  const attrs: ValueMap = new Map();
  let startTime: Timestamp | undefined;
  let time: Timestamp | undefined;
  let count = 0;
  let sum = 0;
  let scale = 0;
  let zeroCount = 0;
  let positive: ExpBuckets = { offset: 0, counts: [] };
  let negative: ExpBuckets = { offset: 0, counts: [] };
  let zeroThreshold = 0;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        decodeAttributeInto(attrs, r.readBytes(), options);
        break;
      case 2:
        startTime = readOptionalTimestamp(r);
        break;
      case 3:
        time = readOptionalTimestamp(r);
        break;
      case 4:
        count = Number(r.readFixed64());
        break;
      case 5:
        sum = r.readDouble();
        break;
      case 6:
        scale = r.readZigZag32();
        break;
      case 7:
        zeroCount = Number(r.readFixed64());
        break;
      case 8:
        positive = decodeExpBuckets(r.readBytes(), options);
        break;
      case 9:
        negative = decodeExpBuckets(r.readBytes(), options);
        break;
      case 14:
        zeroThreshold = r.readDouble();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return {
    attrs,
    startTime,
    time,
    count,
    sum,
    scale,
    zeroCount,
    positive,
    negative,
    zeroThreshold,
  };
}

function decodeExpBuckets(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
): ExpBuckets {
  let offset = 0;
  let counts: bigint[] = [];
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        offset = r.readZigZag32();
        break;
      case 2:
        counts = r.readPacked((ir) => ir.readVarint());
        checkCollectionSize(counts.length, options);
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return { offset, counts };
}

function expandExponentialBuckets(
  dp: ReturnType<typeof decodeExponentialHistogramDataPoint>,
  options: ReturnType<typeof resolveDecodeOptions>,
): Bucket[] {
  const totalBuckets =
    dp.positive.counts.length + dp.negative.counts.length + (dp.zeroCount > 0 ? 1 : 0);
  if (totalBuckets > options.maxCollectionSize) {
    throw new LimitExceededError(
      'otlp.histogram.buckets',
      options.maxCollectionSize,
      'too many exponential histogram buckets',
    );
  }
  const base = Math.pow(2, Math.pow(2, -dp.scale));
  const buckets: Bucket[] = [];
  for (let i = dp.negative.counts.length - 1; i >= 0; i--) {
    const index = dp.negative.offset + i;
    const upperLimit = -Math.pow(base, index);
    buckets.push({ upperLimit: finiteOrThrow(upperLimit), count: Number(dp.negative.counts[i]!) });
  }
  if (dp.zeroCount > 0) buckets.push({ upperLimit: dp.zeroThreshold, count: dp.zeroCount });
  for (let i = 0; i < dp.positive.counts.length; i++) {
    const index = dp.positive.offset + i;
    const upperLimit = Math.pow(base, index + 1);
    buckets.push({ upperLimit: finiteOrThrow(upperLimit), count: Number(dp.positive.counts[i]!) });
  }
  return buckets;
}

function finiteOrThrow(n: number): number {
  if (!Number.isFinite(n)) {
    throw new LimitExceededError(
      'otlp.histogram.scale',
      0,
      'exponential histogram scale/offset produced a non-finite bucket boundary',
    );
  }
  return n;
}

function decodeSummary(
  bytes: Uint8Array,
  name: string,
  baseTags: Map<string, string>,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: MetricEvent[],
): void {
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    const dp = decodeSummaryDataPoint(r.readBytes(), options);
    const tags = mergeTags(baseTags, dp.attrs);
    const value: MetricValue = {
      type: 'summary',
      quantiles: dp.quantiles,
      count: dp.count,
      sum: dp.sum,
    };
    out.push(buildEvent(name, tags, 'absolute', value, dp));
  });
}

function decodeSummaryDataPoint(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
) {
  const attrs: ValueMap = new Map();
  let startTime: Timestamp | undefined;
  let time: Timestamp | undefined;
  let count = 0;
  let sum = 0;
  const quantiles: Quantile[] = [];
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 7:
        decodeAttributeInto(attrs, r.readBytes(), options);
        break;
      case 2:
        startTime = readOptionalTimestamp(r);
        break;
      case 3:
        time = readOptionalTimestamp(r);
        break;
      case 4:
        count = Number(r.readFixed64());
        break;
      case 5:
        sum = r.readDouble();
        break;
      case 6: {
        checkCollectionSize(quantiles.length + 1, options);
        quantiles.push(decodeValueAtQuantile(r.readBytes()));
        break;
      }
      default:
        r.skipValue(wireType);
    }
  });
  return { attrs, startTime, time, count, sum, quantiles };
}

function decodeValueAtQuantile(bytes: Uint8Array): Quantile {
  let quantile = 0;
  let value = 0;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        quantile = r.readDouble();
        break;
      case 2:
        value = r.readDouble();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return { quantile, value };
}

function checkCollectionSize(size: number, options: ReturnType<typeof resolveDecodeOptions>): void {
  if (size > options.maxCollectionSize) {
    throw new LimitExceededError(
      'otlp.collection.size',
      options.maxCollectionSize,
      'too many repeated elements',
    );
  }
}

function buildEvent(
  name: string,
  tags: Map<string, string>,
  kind: MetricKind,
  value: MetricValue,
  point: { startTime?: Timestamp | undefined; time?: Timestamp | undefined },
): MetricEvent {
  const init: ConstructorParameters<typeof MetricEvent>[0] = {
    name,
    tags,
    kind,
    value,
    metadata: createMetadata(),
  };
  const time = point.time;
  if (time !== undefined) init.timestamp = time;
  if (point.startTime !== undefined && time !== undefined) {
    const intervalNanos = time.since(point.startTime);
    if (intervalNanos > 0n) init.intervalMs = Number(intervalNanos / 1_000_000n);
  }
  return new MetricEvent(init);
}

function mergeTags(base: Map<string, string>, attributes: ValueMap): Map<string, string> {
  const tags = new Map(base);
  for (const [k, v] of tagsFromAttributes(attributes)) tags.set(k, v);
  return tags;
}

function tagsFromAttributes(attributes: ValueMap): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [k, v] of attributes) tags.set(k, stringifyAttributeValue(v));
  return tags;
}

/** Renders an attribute {@link Value} as a string tag. See {@link stringifyValue}. */
export function stringifyAttributeValue(value: Value): string {
  return stringifyValue(value);
}

export interface EncodeMetricsOptions {
  /** Maximum number of `MetricEvent`s to encode into one request. Default unlimited. */
  maxEvents?: number;
}

/**
 * Encodes `events` into one `ExportMetricsServiceRequest`. Events are grouped into `Metric`
 * messages by `(namespace + name, value type, and — for counters/gauges — kind)`, since one
 * `Metric` can only describe data points of a single OTLP shape.
 */
export function encodeExportMetricsServiceRequest(
  events: readonly MetricEvent[],
  options: EncodeMetricsOptions = {},
): Uint8Array {
  if (options.maxEvents !== undefined && events.length > options.maxEvents) {
    throw new RangeError(
      `cannot encode ${events.length} events, exceeding maxEvents (${options.maxEvents})`,
    );
  }
  const groups = new Map<string, MetricEvent[]>();
  for (const event of events) {
    if (event.value.type === 'set' || event.value.type === 'distribution') {
      throw new FerruleError(
        'E_OTLP_UNSUPPORTED_METRIC_TYPE',
        `OTLP has no representation for metric value type ${JSON.stringify(event.value.type)}; convert it to a histogram or summary first`,
      );
    }
    const fullName =
      event.series.namespace !== undefined
        ? `${event.series.namespace}.${event.series.name}`
        : event.series.name;
    const key = `${fullName}\u0000${event.value.type}\u0000${event.value.type === 'counter' || event.value.type === 'gauge' ? event.metricKind : ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(event);
  }

  const w = new ProtoWriter();
  w.writeMessage(1, (rm) => {
    rm.writeMessage(2, (sm) => {
      for (const group of groups.values()) {
        sm.writeMessage(2, (metric) => writeMetric(metric, group));
      }
    });
  });
  return w.finish();
}

function writeMetric(w: ProtoWriter, group: readonly MetricEvent[]): void {
  const first = group[0]!;
  w.writeString(1, first.series.name);
  switch (first.value.type) {
    case 'gauge':
      // An absolute gauge maps to OTLP's Gauge (which has no temporality concept). An
      // incremental gauge has no home there — OTLP's Gauge is always a "current value" — so it
      // is encoded as a non-monotonic, delta Sum instead, which round-trips the kind.
      if (first.metricKind === 'incremental') {
        w.writeMessage(7, (s) => {
          s.writeInt32(2, TEMPORALITY_DELTA);
          s.writeBool(3, false);
          for (const event of group) {
            s.writeMessage(1, (dp) =>
              writeNumberDataPoint(
                dp,
                event,
                event.value as Extract<MetricValue, { type: 'gauge' }>,
              ),
            );
          }
        });
        return;
      }
      w.writeMessage(5, (g) => {
        for (const event of group) {
          g.writeMessage(1, (dp) =>
            writeNumberDataPoint(dp, event, event.value as Extract<MetricValue, { type: 'gauge' }>),
          );
        }
      });
      return;
    case 'counter':
      w.writeMessage(7, (s) => {
        s.writeInt32(
          2,
          first.metricKind === 'incremental' ? TEMPORALITY_DELTA : TEMPORALITY_CUMULATIVE,
        );
        s.writeBool(3, true);
        for (const event of group) {
          s.writeMessage(1, (dp) =>
            writeNumberDataPoint(
              dp,
              event,
              event.value as Extract<MetricValue, { type: 'counter' }>,
            ),
          );
        }
      });
      return;
    case 'histogram':
      w.writeMessage(9, (h) => {
        h.writeInt32(
          2,
          first.metricKind === 'incremental' ? TEMPORALITY_DELTA : TEMPORALITY_CUMULATIVE,
        );
        for (const event of group) {
          h.writeMessage(1, (dp) =>
            writeHistogramDataPoint(
              dp,
              event,
              event.value as Extract<MetricValue, { type: 'histogram' }>,
            ),
          );
        }
      });
      return;
    case 'summary':
      w.writeMessage(11, (sm) => {
        for (const event of group) {
          sm.writeMessage(1, (dp) =>
            writeSummaryDataPoint(
              dp,
              event,
              event.value as Extract<MetricValue, { type: 'summary' }>,
            ),
          );
        }
      });
      return;
    case 'set':
    case 'distribution':
      // Filtered out before grouping; unreachable, kept for exhaustiveness.
      return;
  }
}

function writeAttributesFromTags(w: ProtoWriter, field: number, tags: Map<string, string>): void {
  const attrs: ValueMap = new Map();
  for (const [k, v] of tags) attrs.set(k, v);
  writeAttributes(w, field, attrs);
}

function writePointTimestamps(
  w: ProtoWriter,
  event: MetricEvent,
  timeField: number,
  startField: number,
): void {
  const time = event.timestamp ?? Timestamp.now();
  writeTimestamp(w, timeField, time);
  if (event.intervalMs !== undefined) {
    writeTimestamp(
      w,
      startField,
      Timestamp.fromNanos(time.nanos - BigInt(event.intervalMs) * 1_000_000n),
    );
  }
}

function writeNumberDataPoint(w: ProtoWriter, event: MetricEvent, value: { value: number }): void {
  writeAttributesFromTags(w, 7, event.series.tags);
  writePointTimestamps(w, event, 3, 2);
  w.writeDouble(4, value.value);
}

function writeHistogramDataPoint(
  w: ProtoWriter,
  event: MetricEvent,
  value: Extract<MetricValue, { type: 'histogram' }>,
): void {
  writeAttributesFromTags(w, 9, event.series.tags);
  writePointTimestamps(w, event, 3, 2);
  w.writeFixed64(4, BigInt(Math.round(value.count)));
  w.writeDouble(5, value.sum);
  const overflow = value.count - value.buckets.reduce((sum, b) => sum + b.count, 0);
  w.writePacked(
    6,
    [
      ...value.buckets.map((b) => BigInt(Math.round(b.count))),
      BigInt(Math.round(Math.max(0, overflow))),
    ],
    (item, count) => item.writeRawFixed64(count),
  );
  w.writePacked(7, value.buckets, (item, bucket) => item.writeRawDouble(bucket.upperLimit));
}

function writeSummaryDataPoint(
  w: ProtoWriter,
  event: MetricEvent,
  value: Extract<MetricValue, { type: 'summary' }>,
): void {
  writeAttributesFromTags(w, 7, event.series.tags);
  writePointTimestamps(w, event, 3, 2);
  w.writeFixed64(4, BigInt(Math.round(value.count)));
  w.writeDouble(5, value.sum);
  for (const q of value.quantiles) {
    w.writeMessage(6, (vq) => {
      vq.writeDouble(1, q.quantile);
      vq.writeDouble(2, q.value);
    });
  }
}
