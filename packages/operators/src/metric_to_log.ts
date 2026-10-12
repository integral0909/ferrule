import {
  fromPlain,
  LogEvent,
  objectOf,
  type Event,
  type MetricEvent,
  type ValueMap,
} from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import { defineTransform, DEFAULT_PORT, type TransformOutput } from '@ferrule/runtime';

/**
 * `metric_to_log` — the inverse of `log_to_metric`: represents each metric event as a single log
 * event, for sinks that only understand logs (or for debugging a metric stream by eye). One
 * metric always becomes exactly one log event, so the log's finalizers are the metric's own
 * (moved, not cloned).
 *
 * Output shape (all under `field`, default `.metric`):
 *
 * ```
 * metric:
 *   name: string
 *   namespace: string?
 *   tags: { [key]: string }
 *   kind: "incremental" | "absolute"
 *   timestamp: timestamp?
 *   type: "counter" | "gauge" | "set" | "distribution" | "histogram" | "exponentialHistogram" |
 *         "summary"
 *   value: number            # counter, gauge
 *   values: [string]         # set
 *   samples: [{value, rate}] # distribution
 *   buckets: [{upper_limit, count}], count, sum  # histogram
 *   scale, zero_count, zero_threshold,                     # exponentialHistogram
 *     positive: {offset, counts}, negative: {offset, counts}, count, sum
 *   quantiles: [{quantile, value}], count, sum   # summary
 * ```
 */

export const metricToLogOptions = s.object({
  field: s
    .fieldPath()
    .default(Object.freeze(['metric']))
    .describe('field the metric representation is written under'),
});

export type MetricToLogOptions = Infer<typeof metricToLogOptions>;

/**
 * Every numeric leaf inside a `MetricValue` is a float64 by definition (see `@ferrule/core`'s
 * `MetricValue`), never an integer. `fromPlain`'s default heuristic turns whole-looking JS
 * numbers into `bigint` (integer) values, which would silently change a metric value's kind, so
 * this always converts with `numbers: 'float'` instead of the `objectOf` shorthand.
 */
function floatObject(record: Record<string, unknown>): ValueMap {
  return fromPlain(record, { numbers: 'float' }) as ValueMap;
}

function valueBody(metric: MetricEvent): ValueMap {
  const v = metric.value;
  switch (v.type) {
    case 'counter':
    case 'gauge':
      return floatObject({ type: v.type, value: v.value });
    case 'set':
      return objectOf({ type: 'set', values: [...v.values] });
    case 'distribution':
      return floatObject({
        type: 'distribution',
        statistic: v.statistic,
        samples: v.samples.map((sample) => ({ value: sample.value, rate: sample.rate })),
      });
    case 'histogram':
      return floatObject({
        type: 'histogram',
        buckets: v.buckets.map((b) => ({ upper_limit: b.upperLimit, count: b.count })),
        count: v.count,
        sum: v.sum,
      });
    case 'exponentialHistogram':
      return floatObject({
        type: 'exponentialHistogram',
        scale: v.scale,
        zero_count: v.zeroCount,
        zero_threshold: v.zeroThreshold,
        positive: { offset: v.positive.offset, counts: v.positive.counts },
        negative: { offset: v.negative.offset, counts: v.negative.counts },
        count: v.count,
        sum: v.sum,
      });
    case 'summary':
      return floatObject({
        type: 'summary',
        quantiles: v.quantiles.map((q) => ({ quantile: q.quantile, value: q.value })),
        count: v.count,
        sum: v.sum,
      });
  }
}

export const metricToLogTransform = defineTransform<MetricToLogOptions>({
  kind: 'transform',
  type: 'metric_to_log',
  description: 'Represents each metric event as a single log event.',
  options: metricToLogOptions,
  accepts: ['metric'],
  produces: () => ['log'],
  examples: [{ title: 'Write metrics under a custom field', config: { field: 'm' } }],
  build: (options) => ({
    process(events: Event[], out: TransformOutput) {
      for (const event of events) {
        const metric = event as MetricEvent;
        const fields: ValueMap = objectOf({
          name: metric.series.name,
          namespace: metric.series.namespace ?? null,
          tags: Object.fromEntries(metric.series.tags),
          kind: metric.metricKind,
          timestamp: metric.timestamp ?? null,
        });
        fields.set('value', valueBody(metric));

        const log = new LogEvent(objectOf({}), metric.metadata);
        log.set(options.field, fields);
        out.push(log, DEFAULT_PORT);
      }
    },
  }),
});
