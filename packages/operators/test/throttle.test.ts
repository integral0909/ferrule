import { describe, expect, it } from 'vitest';
import { throttleTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('throttle', () => {
  it('allows up to threshold events per window, then drops', async () => {
    const { transform, harness } = await buildTransform(throttleTransform, {
      threshold: 3,
      window: 1000,
    });
    const events = Array.from({ length: 5 }, (_, i) => logEvent({ i }));
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(3);
    for (const p of harness.pushed) p.event.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('refills over time, admitting more events after the window elapses', async () => {
    const { transform, harness } = await buildTransform(throttleTransform, {
      threshold: 2,
      window: 1000,
    });
    transform.process([logEvent({ i: 0 }), logEvent({ i: 1 }), logEvent({ i: 2 })], harness.out);
    expect(harness.pushed).toHaveLength(2);

    await harness.clock.advance(1000);
    transform.process([logEvent({ i: 3 })], harness.out);
    expect(harness.pushed).toHaveLength(3);
  });

  it('tracks separate budgets per key_field value', async () => {
    const { transform, harness } = await buildTransform(throttleTransform, {
      threshold: 1,
      window: 1000,
      key_field: 'user',
    });
    transform.process(
      [logEvent({ user: 'a' }), logEvent({ user: 'a' }), logEvent({ user: 'b' })],
      harness.out,
    );
    expect(harness.pushed).toHaveLength(2); // first 'a' and the only 'b'
  });

  it('emit_dropped routes throttled events to the dropped port instead of discarding', async () => {
    const { transform, harness } = await buildTransform(throttleTransform, {
      threshold: 1,
      window: 1000,
      emit_dropped: true,
    });
    transform.process([logEvent({ i: 0 }), logEvent({ i: 1 })], harness.out);
    expect(harness.pushed.map((p) => p.port)).toEqual(['_default', 'dropped']);
  });

  it('declares the dropped port only when emit_dropped is set', () => {
    const on = throttleTransform.options.parse({ emit_dropped: true });
    const off = throttleTransform.options.parse({ emit_dropped: false });
    expect(throttleTransform.outputs?.(on)).toEqual([
      { name: 'dropped', description: expect.any(String) as string },
    ]);
    expect(throttleTransform.outputs?.(off)).toEqual([]);
  });

  it('LRU-evicts the least-recently-used key bucket beyond max_keys', async () => {
    const { transform, harness } = await buildTransform(throttleTransform, {
      threshold: 1,
      window: 1000,
      max_keys: 2,
      key_field: 'k',
    });
    // Three distinct keys with a cap of 2 buckets: the first key's bucket is evicted and its
    // budget resets, so a second event for it is admitted again instead of throttled.
    transform.process(
      [logEvent({ k: 'a' }), logEvent({ k: 'b' }), logEvent({ k: 'c' }), logEvent({ k: 'a' })],
      harness.out,
    );
    expect(harness.pushed).toHaveLength(4);
  });
});
