import type { MetricEvent, MetricValue } from '@ferrule/core';
import type { MetricEventJson, MetricValueJson } from './types.js';

function valueToJson(value: MetricValue): MetricValueJson {
  switch (value.type) {
    case 'counter':
    case 'gauge':
      return { type: value.type, value: value.value };
    case 'set':
      return { type: 'set', values: [...value.values] };
    case 'distribution':
      return { type: 'distribution', samples: value.samples.map((s) => ({ ...s })) };
    case 'histogram':
      return {
        type: 'histogram',
        buckets: value.buckets.map((b) => ({ ...b })),
        count: value.count,
        sum: value.sum,
      };
    case 'exponentialHistogram':
      return {
        type: 'exponentialHistogram',
        scale: value.scale,
        zeroCount: value.zeroCount,
        zeroThreshold: value.zeroThreshold,
        positive: { offset: value.positive.offset, counts: [...value.positive.counts] },
        negative: { offset: value.negative.offset, counts: [...value.negative.counts] },
        count: value.count,
        sum: value.sum,
      };
    case 'summary':
      return {
        type: 'summary',
        quantiles: value.quantiles.map((q) => ({ ...q })),
        count: value.count,
        sum: value.sum,
      };
  }
}

/** Converts one recorded {@link MetricEvent} into a JSON-safe shape (a `Map` of tags becomes a
 * plain object, a `Timestamp` becomes an ISO 8601 string). */
export function metricEventToJson(event: MetricEvent): MetricEventJson {
  const tags: Record<string, string> = {};
  for (const [key, value] of event.series.tags) tags[key] = value;
  return {
    name: event.series.name,
    ...(event.series.namespace !== undefined ? { namespace: event.series.namespace } : {}),
    tags,
    kind: event.metricKind,
    value: valueToJson(event.value),
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp.toISOString() } : {}),
    ...(event.intervalMs !== undefined ? { intervalMs: event.intervalMs } : {}),
  };
}
