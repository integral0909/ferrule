import { describe, expect, it } from 'vitest';
import type { MetricEvent } from '@ferrule/core';
import { logToMetricTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('log_to_metric', () => {
  it('emits a counter incremented by 1 by default', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'counter', name: 'requests', tags: { status: '{status}' } }],
    });
    transform.process([logEvent({ status: 200 })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.series.name).toBe('requests');
    expect(metric.series.tags.get('status')).toBe('200');
    expect(metric.value).toEqual({ type: 'counter', value: 1 });
  });

  it('increment_by_value uses the field as the increment amount', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'counter', name: 'bytes', field: 'size', increment_by_value: true }],
    });
    transform.process([logEvent({ size: 42 })], harness.out);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.value).toEqual({ type: 'counter', value: 42 });
  });

  it('emits a gauge as an absolute reading', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'gauge', name: 'mem', field: 'mem_used' }],
    });
    transform.process([logEvent({ mem_used: 12.5 })], harness.out);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.metricKind).toBe('absolute');
    expect(metric.value).toEqual({ type: 'gauge', value: 12.5 });
  });

  it('emits a set with the field rendered as its single member', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'set', name: 'users', field: 'user_id' }],
    });
    transform.process([logEvent({ user_id: 'alice' })], harness.out);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.value).toEqual({ type: 'set', values: new Set(['alice']) });
  });

  it('emits a histogram observation using the configured buckets', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'histogram', name: 'latency', field: 'ms', buckets: [10, 50, 100] }],
    });
    transform.process([logEvent({ ms: 30 })], harness.out);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.value).toMatchObject({ type: 'histogram', count: 1, sum: 30 });
  });

  it('emits a distribution sample', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'distribution', name: 'lat', field: 'ms' }],
    });
    transform.process([logEvent({ ms: 5 })], harness.out);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.value).toEqual({
      type: 'distribution',
      statistic: 'histogram',
      samples: [{ value: 5, rate: 1 }],
    });
  });

  it('skips a spec whose source field is missing, without failing the event', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [{ type: 'gauge', name: 'mem', field: 'mem_used' }],
    });
    const event = logEvent({ other: 1 });
    const batch = sealedBatch([event]);
    transform.process([event], harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('produces multiple metrics from one event and clones the finalizers for fan-out', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [
        { type: 'counter', name: 'requests' },
        { type: 'histogram', name: 'latency', field: 'ms', buckets: [10, 100] },
      ],
    });
    const event = logEvent({ ms: 5 });
    const batch = sealedBatch([event]);
    transform.process([event], harness.out);
    expect(harness.pushed).toHaveLength(2);
    expect(batch.pendingCount).toBe(2); // original finished; two clones remain pending
    for (const p of harness.pushed) {
      (p.event as MetricEvent).metadata.finalizers.finish('delivered');
    }
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('name and tags are rendered from field templates', async () => {
    const { transform, harness } = await buildTransform(logToMetricTransform, {
      metrics: [
        {
          type: 'counter',
          name: 'http.{method}.requests',
          namespace: 'ns_{service}',
          tags: { status: '{status}' },
        },
      ],
    });
    transform.process([logEvent({ method: 'get', service: 'api', status: 200 })], harness.out);
    const metric = harness.pushed[0]!.event as MetricEvent;
    expect(metric.series.name).toBe('http.get.requests');
    expect(metric.series.namespace).toBe('ns_api');
    expect(metric.series.tags.get('status')).toBe('200');
  });
});
