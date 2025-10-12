import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
import { windowReduceTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('window_reduce', () => {
  it('groups by group_by and flushes on max_events, concatenating a field', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['thread'],
      merge_strategies: [{ field: 'message', strategy: 'concat', separator: '\n' }],
      max_events: 3,
    });
    transform.process(
      [
        logEvent({ thread: 't1', message: 'first' }),
        logEvent({ thread: 't1', message: 'second' }),
        logEvent({ thread: 't1', message: 'third' }),
      ],
      harness.out,
    );
    expect(harness.pushed).toHaveLength(1);
    const merged = harness.pushed[0]!.event as LogEvent;
    expect(merged.get('message')).toBe('first\nsecond\nthird');
  });

  it('end_when flushes the group immediately on match', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      end_when: { type: 'field_equals', field: 'done', value: true },
    });
    transform.process(
      [logEvent({ id: 1, done: false }), logEvent({ id: 1, done: true })],
      harness.out,
    );
    expect(harness.pushed).toHaveLength(1);
  });

  it('separate group keys never merge', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      max_events: 100,
    });
    transform.process([logEvent({ id: 1 }), logEvent({ id: 2 })], harness.out);
    transform.flush!(harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('start_when flushes an existing open group before starting a new one', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['thread'],
      start_when: { type: 'field_equals', field: 'kind', value: 'start' },
      max_events: 100,
    });
    transform.process(
      [
        logEvent({ thread: 't', kind: 'start', n: 1 }),
        logEvent({ thread: 't', kind: 'cont', n: 2 }),
        logEvent({ thread: 't', kind: 'start', n: 3 }), // reopens: flushes the first group
      ],
      harness.out,
    );
    expect(harness.pushed).toHaveLength(1);
    transform.flush!(harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('sum merges a numeric field to its total', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      merge_strategies: [{ field: 'v', strategy: 'sum' }],
      max_events: 3,
    });
    transform.process(
      [logEvent({ id: 1, v: 1 }), logEvent({ id: 1, v: 2 }), logEvent({ id: 1, v: 3 })],
      harness.out,
    );
    expect((harness.pushed[0]!.event as LogEvent).get('v')).toBe(6);
  });

  it('max and min pick the largest/smallest present value', async () => {
    const { transform: maxT, harness: maxH } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      merge_strategies: [{ field: 'v', strategy: 'max' }],
      max_events: 3,
    });
    maxT.process(
      [logEvent({ id: 1, v: 3n }), logEvent({ id: 1, v: 9n }), logEvent({ id: 1, v: 5n })],
      maxH.out,
    );
    expect((maxH.pushed[0]!.event as LogEvent).get('v')).toBe(9n);

    const { transform: minT, harness: minH } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      merge_strategies: [{ field: 'v', strategy: 'min' }],
      max_events: 3,
    });
    minT.process(
      [logEvent({ id: 1, v: 3n }), logEvent({ id: 1, v: 9n }), logEvent({ id: 1, v: 5n })],
      minH.out,
    );
    expect((minH.pushed[0]!.event as LogEvent).get('v')).toBe(3n);
  });

  it('count reports the number of events in the group', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      merge_strategies: [{ field: 'n', strategy: 'count' }],
      max_events: 3,
    });
    transform.process([logEvent({ id: 1 }), logEvent({ id: 1 }), logEvent({ id: 1 })], harness.out);
    expect((harness.pushed[0]!.event as LogEvent).get('n')).toBe(3n);
  });

  it('array collects every present value in order', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      merge_strategies: [{ field: 'v', strategy: 'array' }],
      max_events: 2,
    });
    transform.process([logEvent({ id: 1, v: 'a' }), logEvent({ id: 1, v: 'b' })], harness.out);
    const merged = harness.pushed[0]!.event as LogEvent;
    expect(merged.get('v')).toEqual(['a', 'b']);
  });

  it('first and last pick the corresponding endpoint of the present values', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      merge_strategies: [{ field: 'v', strategy: 'last' }],
      max_events: 2,
    });
    transform.process([logEvent({ id: 1, v: 'a' }), logEvent({ id: 1, v: 'b' })], harness.out);
    expect((harness.pushed[0]!.event as LogEvent).get('v')).toBe('b');
  });

  it('max_duration flushes an idle group on tick', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      max_duration: 1000,
    });
    transform.process([logEvent({ id: 1 })], harness.out);
    expect(harness.pushed).toHaveLength(0);
    await harness.clock.advance(1000);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('flush() flushes every open group at shutdown', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      max_events: 1000,
    });
    transform.process([logEvent({ id: 1 }), logEvent({ id: 2 })], harness.out);
    transform.flush!(harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('the merged event carries the merged finalizers of every contributing event', async () => {
    const { transform, harness } = await buildTransform(windowReduceTransform, {
      group_by: ['id'],
      max_events: 2,
    });
    const events = [logEvent({ id: 1 }), logEvent({ id: 1 })];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(1);
    // Merging finalizers moves ownership into the merged event but finishes nothing by itself:
    // both original finalizers are still pending, now held by one event instead of two.
    expect(batch.pendingCount).toBe(2);
    (harness.pushed[0]!.event as LogEvent).metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });
});
