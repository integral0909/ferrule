import { describe, expect, it } from 'vitest';
import type { MetricEvent } from '@ferrule/core';
import { cardinalityLimitTransform } from '@ferrule/operators';
import { buildTransform, counterMetric, sealedBatch } from './helpers.js';

describe('cardinality_limit', () => {
  it('admits distinct combinations up to the limit', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, { limit: 3 });
    for (let i = 0; i < 3; i++) {
      transform.process([counterMetric('m', 1, { i: String(i) })], harness.out);
    }
    expect(harness.pushed).toHaveLength(3);
  });

  it('always re-admits an already-seen combination', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, { limit: 1 });
    transform.process([counterMetric('m', 1, { i: '0' })], harness.out);
    transform.process([counterMetric('m', 1, { i: '0' })], harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('drop_event discards an event beyond the limit and finishes it as delivered', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, {
      limit: 1,
      policy: 'drop_event',
    });
    transform.process([counterMetric('m', 1, { i: '0' })], harness.out);
    const overflow = counterMetric('m', 1, { i: '1' });
    const batch = sealedBatch([overflow]);
    transform.process([overflow], harness.out);
    expect(harness.pushed).toHaveLength(1);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('drop_tag strips the configured tags instead of dropping the event', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, {
      limit: 1,
      policy: 'drop_tag',
      drop_tag_keys: ['i'],
    });
    transform.process([counterMetric('m', 1, { i: '0' })], harness.out);
    transform.process([counterMetric('m', 1, { i: '1' })], harness.out);
    expect(harness.pushed).toHaveLength(2);
    const second = harness.pushed[1]!.event as MetricEvent;
    expect(second.series.tags.has('i')).toBe(false);
  });

  it('drop_tag with no drop_tag_keys strips every tag', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, {
      limit: 1,
      policy: 'drop_tag',
    });
    transform.process([counterMetric('m', 1, { a: '0', b: '0' })], harness.out);
    transform.process([counterMetric('m', 1, { a: '1', b: '1' })], harness.out);
    const second = harness.pushed[1]!.event as MetricEvent;
    expect(second.series.tags.size).toBe(0);
  });

  it('tracks cardinality independently per metric name', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, { limit: 1 });
    transform.process([counterMetric('a', 1, { i: '0' })], harness.out);
    transform.process([counterMetric('b', 1, { i: '0' })], harness.out);
    expect(harness.pushed).toHaveLength(2); // different metric names, each within its own limit
  });

  it('probabilistic mode also enforces the limit (allowing some false positives)', async () => {
    const { transform, harness } = await buildTransform(cardinalityLimitTransform, {
      limit: 10,
      mode: 'probabilistic',
      bloom_false_positive_rate: 0.001,
    });
    for (let i = 0; i < 10; i++) {
      transform.process([counterMetric('m', 1, { i: String(i) })], harness.out);
    }
    expect(harness.pushed.length).toBe(10);
    // An 11th distinct combination should be rejected (dropped, by default policy).
    const overflow = counterMetric('m', 1, { i: '10' });
    const batch = sealedBatch([overflow]);
    transform.process([overflow], harness.out);
    expect(harness.pushed.length).toBe(10);
    await expect(batch.completion).resolves.toBe('delivered');
  });
});
