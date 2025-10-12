import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
import { sampleTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('sample', () => {
  it('rate 1 keeps everything', async () => {
    const { transform, harness } = await buildTransform(sampleTransform, { rate: 1 });
    const events = Array.from({ length: 20 }, (_, i) => logEvent({ i }));
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(20);
  });

  it('rate 0 drops everything and finishes finalizers as delivered', async () => {
    const { transform, harness } = await buildTransform(sampleTransform, { rate: 0 });
    const events = Array.from({ length: 5 }, (_, i) => logEvent({ i }));
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('unkeyed sampling converges to within 1 event of the configured rate', async () => {
    const { transform, harness } = await buildTransform(sampleTransform, { rate: 0.3 });
    const events = Array.from({ length: 1000 }, (_, i) => logEvent({ i }));
    transform.process(events, harness.out);
    expect(Math.abs(harness.pushed.length - 300)).toBeLessThanOrEqual(1);
  });

  it('property: unkeyed sampling keeps within 1 of rate * N for any N events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 500 }),
        async (rate, n) => {
          const { transform, harness } = await buildTransform(sampleTransform, { rate });
          const events = Array.from({ length: n }, (_, i) => logEvent({ i }));
          transform.process(events, harness.out);
          expect(Math.abs(harness.pushed.length - rate * n)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('unkeyed sampling is deterministic across runs with the same rate', async () => {
    const run = async () => {
      const { transform, harness } = await buildTransform(sampleTransform, { rate: 0.37 });
      const events = Array.from({ length: 200 }, (_, i) => logEvent({ i }));
      transform.process(events, harness.out);
      return harness.pushed.map((p) => (p.event as LogEvent).get('i'));
    };
    expect(await run()).toEqual(await run());
  });

  it('keyed sampling: same key always yields the same decision', async () => {
    const { transform, harness } = await buildTransform(sampleTransform, {
      rate: 0.5,
      key_field: 'user',
    });
    const events = Array.from({ length: 50 }, (_, i) => logEvent({ user: 'alice', i }));
    transform.process(events, harness.out);
    // Either all kept or all dropped -- never a mix -- since the key is identical.
    expect(harness.pushed.length === 0 || harness.pushed.length === 50).toBe(true);
  });

  it('keyed sampling converges to the rate across many distinct keys', async () => {
    const rate = 0.2;
    const { transform, harness } = await buildTransform(sampleTransform, { rate, key_field: 'k' });
    const events = Array.from({ length: 5000 }, (_, i) => logEvent({ k: `key-${i}` }));
    transform.process(events, harness.out);
    const fraction = harness.pushed.length / events.length;
    expect(Math.abs(fraction - rate)).toBeLessThan(0.03);
  });

  it('exclude rules always keep a match regardless of rate', async () => {
    const { transform, harness } = await buildTransform(sampleTransform, {
      rate: 0,
      exclude: [{ field: 'level', values: ['error'] }],
    });
    const events = [logEvent({ level: 'error' }), logEvent({ level: 'info' })];
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect((harness.pushed[0]!.event as LogEvent).get('level')).toBe('error');
  });
});
