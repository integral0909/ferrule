import {
  DEFAULT_LATENCY_BUCKETS,
  MetricEvent,
  seriesKey,
  type Bucket,
  type MetricSeries,
} from '@ferrule/core';
import type {
  Clock,
  ComponentKind,
  Counter,
  Gauge,
  Histogram,
  MetricsRecorder,
  MetricTags,
} from './component.js';
import { SystemClock } from './clock.js';

interface CounterState {
  readonly kind: 'counter';
  readonly series: MetricSeries;
  value: number;
}

interface GaugeState {
  readonly kind: 'gauge';
  readonly series: MetricSeries;
  value: number;
}

interface HistogramState {
  readonly kind: 'histogram';
  readonly series: MetricSeries;
  buckets: Bucket[];
  count: number;
  sum: number;
}

type InstrumentState = CounterState | GaugeState | HistogramState;

function mergeTags(base: MetricTags, extra: MetricTags | undefined): Map<string, string> {
  const tags = new Map(Object.entries(base));
  if (extra !== undefined) for (const [k, v] of Object.entries(extra)) tags.set(k, v);
  return tags;
}

/** Index of the first bound >= value (bucket upper limits are inclusive), like core's histograms. */
function bucketIndex(bounds: readonly Bucket[], value: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bounds[mid]!.upperLimit < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface MetricsRegistryOptions {
  clock?: Clock;
}

/**
 * Records Ferrule's own metrics in memory and exposes them as {@link MetricEvent}s for an
 * `internal_metrics` source to emit. Counters and gauges hold a single running value; histograms
 * use fixed, per-name bucket boundaries (default {@link DEFAULT_LATENCY_BUCKETS}, overridable with
 * {@link MetricsRegistry.defineHistogramBuckets} before the first observation).
 */
export class MetricsRegistry implements MetricsRecorder {
  private readonly clock: Clock;
  private readonly instruments = new Map<string, InstrumentState>();
  private readonly wrappers = new Map<string, unknown>();
  private readonly histogramBounds = new Map<string, readonly number[]>();

  constructor(options: MetricsRegistryOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
  }

  /** Sets the bucket boundaries used for histograms of `name`, going forward. */
  defineHistogramBuckets(name: string, buckets: readonly number[]): void {
    this.histogramBounds.set(name, buckets);
  }

  counter(name: string, tags?: MetricTags): Counter {
    const key = this.seriesFor('counter', name, tags);
    const cached = this.wrappers.get(key) as Counter | undefined;
    if (cached !== undefined) return cached;
    let state = this.instruments.get(key) as CounterState | undefined;
    state ??= { kind: 'counter', series: this.seriesOf(name, tags), value: 0 };
    this.instruments.set(key, state);
    const wrapper: Counter = {
      increment: (by = 1) => {
        state.value += by;
      },
    };
    this.wrappers.set(key, wrapper);
    return wrapper;
  }

  gauge(name: string, tags?: MetricTags): Gauge {
    const key = this.seriesFor('gauge', name, tags);
    const cached = this.wrappers.get(key) as Gauge | undefined;
    if (cached !== undefined) return cached;
    let state = this.instruments.get(key) as GaugeState | undefined;
    state ??= { kind: 'gauge', series: this.seriesOf(name, tags), value: 0 };
    this.instruments.set(key, state);
    const wrapper: Gauge = {
      set: (value: number) => {
        state.value = value;
      },
      add: (delta: number) => {
        state.value += delta;
      },
    };
    this.wrappers.set(key, wrapper);
    return wrapper;
  }

  histogram(name: string, tags?: MetricTags): Histogram {
    const key = this.seriesFor('histogram', name, tags);
    const cached = this.wrappers.get(key) as Histogram | undefined;
    if (cached !== undefined) return cached;
    let state = this.instruments.get(key) as HistogramState | undefined;
    state ??= {
      kind: 'histogram',
      series: this.seriesOf(name, tags),
      buckets: (this.histogramBounds.get(name) ?? DEFAULT_LATENCY_BUCKETS).map((upperLimit) => ({
        upperLimit,
        count: 0,
      })),
      count: 0,
      sum: 0,
    };
    this.instruments.set(key, state);
    const wrapper: Histogram = {
      record: (value: number) => {
        state.count++;
        state.sum += value;
        const i = bucketIndex(state.buckets, value);
        if (i < state.buckets.length) state.buckets[i]!.count++;
      },
    };
    this.wrappers.set(key, wrapper);
    return wrapper;
  }

  private seriesOf(name: string, tags: MetricTags | undefined): MetricSeries {
    return { name, tags: mergeTags({}, tags) };
  }

  private seriesFor(
    kind: InstrumentState['kind'],
    name: string,
    tags: MetricTags | undefined,
  ): string {
    return `${kind}\u0000${seriesKey(this.seriesOf(name, tags))}`;
  }

  /** A view that automatically tags every metric with the given component's identity. */
  forComponent(id: string, kind: ComponentKind, type: string): MetricsRecorder {
    return new ScopedMetricsRecorder(this, {
      component_id: id,
      component_kind: kind,
      component_type: type,
    });
  }

  /** A view that automatically merges `tags` into every metric recorded through it. */
  scoped(tags: MetricTags): MetricsRecorder {
    return new ScopedMetricsRecorder(this, tags);
  }

  /** Every currently recorded instrument as a {@link MetricEvent}, snapshotted now. */
  snapshot(): MetricEvent[] {
    const now = this.clock.now();
    const events: MetricEvent[] = [];
    for (const state of this.instruments.values()) {
      switch (state.kind) {
        case 'counter':
          events.push(
            new MetricEvent({
              name: state.series.name,
              tags: state.series.tags,
              kind: 'absolute',
              value: { type: 'counter', value: state.value },
              timestamp: now,
            }),
          );
          break;
        case 'gauge':
          events.push(
            new MetricEvent({
              name: state.series.name,
              tags: state.series.tags,
              kind: 'absolute',
              value: { type: 'gauge', value: state.value },
              timestamp: now,
            }),
          );
          break;
        case 'histogram':
          events.push(
            new MetricEvent({
              name: state.series.name,
              tags: state.series.tags,
              kind: 'absolute',
              value: {
                type: 'histogram',
                buckets: state.buckets.map((b) => ({ ...b })),
                count: state.count,
                sum: state.sum,
              },
              timestamp: now,
            }),
          );
          break;
      }
    }
    return events;
  }

  /** Removes every instrument. Mainly for tests. */
  clear(): void {
    this.instruments.clear();
    this.wrappers.clear();
  }
}

/** A {@link MetricsRecorder} that merges fixed tags into every call before delegating. */
class ScopedMetricsRecorder implements MetricsRecorder {
  constructor(
    private readonly parent: MetricsRegistry,
    private readonly baseTags: MetricTags,
  ) {}

  private merge(tags: MetricTags | undefined): MetricTags {
    return tags === undefined ? this.baseTags : { ...this.baseTags, ...tags };
  }

  counter(name: string, tags?: MetricTags): Counter {
    return this.parent.counter(name, this.merge(tags));
  }

  gauge(name: string, tags?: MetricTags): Gauge {
    return this.parent.gauge(name, this.merge(tags));
  }

  histogram(name: string, tags?: MetricTags): Histogram {
    return this.parent.histogram(name, this.merge(tags));
  }
}
