import type { Timestamp } from '@ferrule/core';
import {
  addMetricValues,
  cloneMetricValue,
  cloneSeries,
  createMetadata,
  Finalizers,
  MetricEvent,
  seriesKey,
  subtractMetricValues,
  type Event,
  type MetricKind,
  type MetricSeries,
  type MetricValue,
} from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  type Counter,
  type Gauge,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import { LruCache } from './util/lru.js';

/**
 * `aggregate` — combines metric events per series over a tumbling window, flushed on tick.
 *
 * - Incremental readings (counters, sets, distributions, histograms) are summed within the
 *   window with {@link addMetricValues}.
 * - Absolute readings (gauges, cumulative counters as scraped) are kept as their latest value
 *   within the window, unless `convert_absolute_to_incremental` is set, in which case each new
 *   absolute reading is turned into a delta from the previous one ({@link subtractMetricValues},
 *   including counter-reset detection) and that delta is summed like any other incremental value.
 * - `convert_incremental_to_absolute` additionally emits a running total (an absolute value)
 *   instead of the window's incremental sum, useful for feeding a system that only understands
 *   cumulative counters.
 *
 * Every series that received at least one update in a window is emitted once, carrying the
 * merged finalizers of every event that contributed to it — an input event's acknowledgement
 * completes only when its window's aggregate reaches a sink. A first absolute reading (nothing
 * to delta against yet) or a reading incompatible with the series' current shape (e.g. mismatched
 * histogram buckets) cannot be aggregated; it is acknowledged immediately instead of held.
 */

export const aggregateOptions = s.object({
  interval: s
    .duration({ minMs: 1 })
    .default(10_000)
    .describe('tumbling window length; the aggregate for a series flushes once per interval'),
  convert_absolute_to_incremental: s
    .boolean()
    .default(false)
    .describe('turn absolute readings into deltas from the previous reading before summing'),
  convert_incremental_to_absolute: s
    .boolean()
    .default(false)
    .describe('emit a running total (absolute) instead of each window’s incremental sum'),
  max_series: s
    .integer({ min: 1 })
    .default(100_000)
    .describe(
      'maximum distinct series tracked at once (least-recently-updated evicted beyond this)',
    ),
  stale_after: s
    .duration({ minMs: 1 })
    .optional()
    .describe('evict a series not updated in this long; default 10× interval'),
});

export type AggregateOptions = Infer<typeof aggregateOptions>;

interface SeriesState {
  series: MetricSeries;
  kind: MetricKind;
  value: MetricValue | undefined;
  dirty: boolean;
  finalizers: Finalizers;
  lastAbsolute: MetricValue | undefined;
  runningTotal: MetricValue | undefined;
  lastUpdatedMonoMs: number;
}

export const aggregateTransform = defineTransform<AggregateOptions>({
  kind: 'transform',
  type: 'aggregate',
  description: 'Combines incremental metrics per series over a tumbling window.',
  options: aggregateOptions,
  accepts: ['metric'],
  examples: [
    {
      title: 'Roll up per-request counters into 10-second totals',
      config: { interval: '10s' },
    },
    {
      title: 'Turn cumulative scrapes into per-minute deltas',
      config: { interval: '1m', convert_absolute_to_incremental: true },
    },
  ],
  build: (options) => {
    let ctx!: TransformContext;
    let incompatibleCounter!: Counter;
    let activeSeriesGauge!: Gauge;
    const staleAfterMs = options.stale_after ?? options.interval * 10;

    const evictState = (state: SeriesState, reason: 'max_series' | 'stale'): void => {
      if (!state.finalizers.isEmpty) state.finalizers.finish('errored');
      ctx.metrics.counter('aggregate_series_evicted_total', { reason }).increment(1);
    };

    const buckets = new LruCache<SeriesState>({
      maxSize: options.max_series,
      onEvict: (_key, state) => evictState(state, 'max_series'),
    });

    const stateFor = (series: MetricSeries, nowMs: number): SeriesState => {
      const key = seriesKey(series);
      let state = buckets.get(key);
      if (state === undefined) {
        state = {
          series: cloneSeries(series),
          kind: 'incremental',
          value: undefined,
          dirty: false,
          finalizers: new Finalizers(),
          lastAbsolute: undefined,
          runningTotal: undefined,
          lastUpdatedMonoMs: nowMs,
        };
        buckets.set(key, state);
      }
      return state;
    };

    const combineIncremental = (state: SeriesState, contribution: MetricValue): void => {
      state.kind = 'incremental';
      if (state.value === undefined) {
        state.value = cloneMetricValue(contribution);
        return;
      }
      const combined = addMetricValues(state.value, contribution);
      if (combined === undefined) {
        incompatibleCounter.increment(1);
        state.value = cloneMetricValue(contribution);
        return;
      }
      state.value = combined;
    };

    const flushState = (state: SeriesState, now: Timestamp, out: TransformOutput): void => {
      if (!state.dirty || state.value === undefined) return;
      let emitKind: MetricKind = state.kind;
      let emitValue = state.value;
      if (options.convert_incremental_to_absolute && state.kind === 'incremental') {
        const total =
          state.runningTotal === undefined
            ? state.value
            : addMetricValues(state.runningTotal, state.value);
        emitValue = total ?? state.value;
        state.runningTotal = emitValue;
        emitKind = 'absolute';
      }
      const init: ConstructorParameters<typeof MetricEvent>[0] = {
        name: state.series.name,
        tags: state.series.tags,
        kind: emitKind,
        value: cloneMetricValue(emitValue),
        timestamp: now,
        intervalMs: options.interval,
        metadata: createMetadata({ receivedAt: now }),
      };
      if (state.series.namespace !== undefined) init.namespace = state.series.namespace;
      const metric = new MetricEvent(init);
      metric.metadata.finalizers.merge(state.finalizers);
      out.push(metric, DEFAULT_PORT);
      state.dirty = false;
      state.value = undefined;
    };

    return {
      start(context) {
        ctx = context;
        incompatibleCounter = ctx.metrics.counter('aggregate_incompatible_values_total');
        activeSeriesGauge = ctx.metrics.gauge('aggregate_active_series');
      },
      process(events: Event[], _out: TransformOutput) {
        const nowMs = ctx.clock.monotonic();
        for (const event of events) {
          const metricEvent = event as MetricEvent;
          const state = stateFor(metricEvent.series, nowMs);
          state.lastUpdatedMonoMs = nowMs;

          let contribution: MetricValue | undefined;
          if (metricEvent.metricKind === 'absolute') {
            if (options.convert_absolute_to_incremental) {
              const previous = state.lastAbsolute;
              state.lastAbsolute = cloneMetricValue(metricEvent.value);
              if (previous === undefined) {
                contribution = undefined; // nothing to delta against yet
              } else {
                const delta = subtractMetricValues(metricEvent.value, previous);
                contribution = delta.kind === 'incompatible' ? undefined : delta.value;
                if (delta.kind === 'incompatible') incompatibleCounter.increment(1);
              }
            } else {
              state.kind = 'absolute';
              state.value = cloneMetricValue(metricEvent.value);
              state.dirty = true;
              metricEvent.metadata.finalizers.finish('delivered');
              continue;
            }
          } else {
            contribution = metricEvent.value;
          }

          if (contribution === undefined) {
            metricEvent.metadata.finalizers.finish('delivered');
            continue;
          }
          combineIncremental(state, contribution);
          state.dirty = true;
          state.finalizers.merge(metricEvent.metadata.finalizers);
        }
        activeSeriesGauge.set(buckets.size);
      },
      tickIntervalMs: options.interval,
      tick(now, out) {
        const nowMs = ctx.clock.monotonic();
        for (const [key, state] of [...buckets.entries()]) {
          if (nowMs - state.lastUpdatedMonoMs >= staleAfterMs) {
            buckets.delete(key);
            if (state.dirty) flushState(state, now, out);
            evictState(state, 'stale');
            continue;
          }
          flushState(state, now, out);
        }
        activeSeriesGauge.set(buckets.size);
      },
      flush(out) {
        const now = ctx.clock.now();
        for (const [, state] of [...buckets.entries()]) {
          flushState(state, now, out);
          if (!state.finalizers.isEmpty) state.finalizers.finish('errored');
        }
        buckets.clear();
      },
    };
  },
});
