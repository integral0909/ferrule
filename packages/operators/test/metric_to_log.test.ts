import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
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
