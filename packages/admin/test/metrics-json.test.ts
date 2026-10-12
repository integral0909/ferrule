import { MetricEvent, Timestamp } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { metricEventToJson } from '../src/metrics-json.js';

describe('metricEventToJson', () => {
  it('converts tags from a Map to a plain object', () => {
    const event = new MetricEvent({
      name: 'component_sent_events_total',
      tags: new Map([
        ['component_id', 'app_logs'],
        ['component_kind', 'source'],
      ]),
      kind: 'absolute',
      value: { type: 'counter', value: 12 },
    });
    const json = metricEventToJson(event);
    expect(json.tags).toEqual({ component_id: 'app_logs', component_kind: 'source' });
  });

  it('renders a timestamp as an ISO 8601 string, and omits it when absent', () => {
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    const withTs = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: { type: 'gauge', value: 1 },
      timestamp: ts,
    });
    expect(metricEventToJson(withTs).timestamp).toBe(ts.toISOString());

    const withoutTs = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: { type: 'gauge', value: 1 },
    });
    expect(metricEventToJson(withoutTs).timestamp).toBeUndefined();
    expect('timestamp' in metricEventToJson(withoutTs)).toBe(false);
  });

  it('converts a set value to an array of its members', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: { type: 'set', values: new Set(['a', 'b', 'c']) },
    });
    expect(metricEventToJson(event).value).toEqual({ type: 'set', values: ['a', 'b', 'c'] });
  });

  it('preserves histogram buckets, count, and sum', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: {
        type: 'histogram',
        buckets: [{ upperLimit: 1, count: 4 }],
        count: 4,
        sum: 3.2,
      },
    });
    expect(metricEventToJson(event).value).toEqual({
      type: 'histogram',
      buckets: [{ upperLimit: 1, count: 4 }],
      count: 4,
      sum: 3.2,
    });
  });

  it('preserves exponentialHistogram scale, zero bucket, and sparse buckets', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: {
        type: 'exponentialHistogram',
        scale: 1,
        zeroCount: 2,
        zeroThreshold: 0.5,
        positive: { offset: 0, counts: [3, 4] },
        negative: { offset: -1, counts: [5] },
        count: 14,
        sum: 10,
      },
    });
    expect(metricEventToJson(event).value).toEqual({
      type: 'exponentialHistogram',
      scale: 1,
      zeroCount: 2,
      zeroThreshold: 0.5,
      positive: { offset: 0, counts: [3, 4] },
      negative: { offset: -1, counts: [5] },
      count: 14,
      sum: 10,
    });
  });

  it('preserves summary quantiles, count, and sum', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: {
        type: 'summary',
        quantiles: [{ quantile: 0.5, value: 12 }],
        count: 10,
        sum: 120,
      },
    });
    expect(metricEventToJson(event).value).toEqual({
      type: 'summary',
      quantiles: [{ quantile: 0.5, value: 12 }],
      count: 10,
      sum: 120,
    });
  });

  it('preserves distribution samples', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'incremental',
      value: { type: 'distribution', samples: [{ value: 1, rate: 1 }], statistic: 'histogram' },
    });
    expect(metricEventToJson(event).value).toEqual({
      type: 'distribution',
      samples: [{ value: 1, rate: 1 }],
    });
    expect(metricEventToJson(event).kind).toBe('incremental');
  });

  it('includes namespace only when set', () => {
    const withNs = new MetricEvent({
      name: 'x',
      namespace: 'ferrule',
      kind: 'absolute',
      value: { type: 'gauge', value: 0 },
    });
    expect(metricEventToJson(withNs).namespace).toBe('ferrule');
    const withoutNs = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: { type: 'gauge', value: 0 },
    });
    expect('namespace' in metricEventToJson(withoutNs)).toBe(false);
  });
});
