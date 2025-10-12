import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dedupeTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('dedupe', () => {
  it('drops an exact duplicate and finishes it as delivered', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, {});
    const a = logEvent({ msg: 'hi', n: 1 });
    const b = logEvent({ msg: 'hi', n: 1 });
    const batch = sealedBatch([a, b]);
    transform.process([a, b], harness.out);
    expect(harness.pushed).toHaveLength(1);
    for (const p of harness.pushed) p.event.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('does not drop events that differ in any field', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, {});
    transform.process([logEvent({ msg: 'a' }), logEvent({ msg: 'b' })], harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('field order does not affect the fingerprint', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, {});
    const a = logEvent({ x: 1, y: 2 });
    const b = logEvent({ y: 2, x: 1 });
    transform.process([a, b], harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('fields restricts the dedupe key to the listed paths', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, { fields: ['id'] });
    transform.process([logEvent({ id: 1, ts: 'a' }), logEvent({ id: 1, ts: 'b' })], harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('ignore_fields excludes noisy fields (e.g. a timestamp) from the key', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, { ignore_fields: ['ts'] });
    transform.process([logEvent({ msg: 'x', ts: 1 }), logEvent({ msg: 'x', ts: 2 })], harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('a duplicate outside the TTL is treated as new again', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, { ttl: 100 });
    transform.process([logEvent({ msg: 'x' })], harness.out);
    await harness.clock.advance(150);
    transform.process([logEvent({ msg: 'x' })], harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('respects cache_size, evicting the oldest fingerprint (LRU)', async () => {
    const { transform, harness } = await buildTransform(dedupeTransform, { cache_size: 1 });
    transform.process([logEvent({ msg: 'a' })], harness.out);
    transform.process([logEvent({ msg: 'b' })], harness.out); // evicts 'a' from the cache
    transform.process([logEvent({ msg: 'a' })], harness.out); // 'a' looks new again
    expect(harness.pushed).toHaveLength(3);
  });

  it('property: never emits two events with an identical dedupe key within the TTL', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 50 }),
        async (keys) => {
          const { transform, harness } = await buildTransform(dedupeTransform, { ttl: 60_000 });
          const events = keys.map((k) => logEvent({ k }));
          transform.process(events, harness.out);
          const seenKeys = harness.pushed.map((p) =>
            events.indexOf(p.event as (typeof events)[number]),
          );
          const distinctInputKeys = new Set(keys).size;
          expect(harness.pushed.length).toBe(distinctInputKeys);
          expect(seenKeys.every((i) => i >= 0)).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });
});
