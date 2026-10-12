import { describe, expect, it } from 'vitest';
import { MetricEvent, type LogEvent } from '@ferrule/core';
import { metricToLogTransform } from '@ferrule/operators';
import { buildTransform, counterMetric, sealedBatch } from './helpers.js';

describe('metric_to_log', () => {
  it('represents a counter as a log event under .metric', async () => {
    const { transform, harness } = await buildTransform(metricToLogTransform, {});
    transform.process([counterMetric('reqs', 3, { status: '200' })], harness.out);
    const log = harness.pushed[0]!.event as LogEvent;
    expect(log.get('metric.name')).toBe('reqs');
    expect(log.get('metric.kind')).toBe('incremental');
    expect((log.get('metric.tags') as Map<string, unknown>).get('status')).toBe('200');
    expect(log.get('metric.value.type')).toBe('counter');
    expect(log.get('metric.value.value')).toBe(3);
  });

  it('writes under a custom field when configured', async () => {
    const { transform, harness } = await buildTransform(metricToLogTransform, { field: 'm' });
    transform.process([counterMetric('x', 1)], harness.out);
    const log = harness.pushed[0]!.event as LogEvent;
    expect(log.has('metric')).toBe(false);
    expect(log.get('m.name')).toBe('x');
  });

  it('represents an exponentialHistogram with its scale, zero bucket, and sparse buckets', async () => {
    const { transform, harness } = await buildTransform(metricToLogTransform, {});
    const metric = new MetricEvent({
      name: 'latency',
      tags: new Map(),
      kind: 'absolute',
      value: {
        type: 'exponentialHistogram',
        scale: 0,
        zeroCount: 1,
        zeroThreshold: 0.001,
        positive: { offset: 0, counts: [3, 5] },
        negative: { offset: -1, counts: [2] },
        count: 11,
        sum: 42,
      },
    });
    transform.process([metric], harness.out);
    const log = harness.pushed[0]!.event as LogEvent;
    expect(log.get('metric.value.type')).toBe('exponentialHistogram');
    expect(log.get('metric.value.scale')).toBe(0);
    expect(log.get('metric.value.zero_count')).toBe(1);
    expect(log.get('metric.value.zero_threshold')).toBe(0.001);
    expect(log.get('metric.value.positive.offset')).toBe(0);
    expect(log.get('metric.value.positive.counts')).toEqual([3, 5]);
    expect(log.get('metric.value.negative.offset')).toBe(-1);
    expect(log.get('metric.value.count')).toBe(11);
    expect(log.get('metric.value.sum')).toBe(42);
  });

  it('moves the metric finalizers to the log event one-to-one', async () => {
    const { transform, harness } = await buildTransform(metricToLogTransform, {});
    const metric = counterMetric('x', 1);
    const batch = sealedBatch([metric]);
    transform.process([metric], harness.out);
    const log = harness.pushed[0]!.event as LogEvent;
    log.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });
});
