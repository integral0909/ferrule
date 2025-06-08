import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '@ferrule/runtime';
import { Batcher } from '@ferrule/runtime';

describe('Batcher', () => {
  it('flushes once maxEvents is reached', () => {
    const flushed: number[][] = [];
    const batcher = new Batcher<number>({
      maxEvents: 2,
      onFlush: (_k, items) => flushed.push(items),
    });
    batcher.add(1);
    expect(flushed).toHaveLength(0);
    batcher.add(2);
    expect(flushed).toEqual([[1, 2]]);
  });

  it('flushes once maxBytes is reached', () => {
    const flushed: string[][] = [];
    const batcher = new Batcher<string>({
      maxBytes: 5,
      sizeOf: (s) => s.length,
      onFlush: (_k, items) => flushed.push(items),
    });
    batcher.add('ab');
    batcher.add('abc');
    expect(flushed).toEqual([['ab', 'abc']]);
  });

  it('flushes after a timeout even without reaching a size limit', async () => {
    const clock = new ManualClock();
    const flushed: number[][] = [];
    const batcher = new Batcher<number>({
      timeoutMs: 100,
      clock,
      onFlush: (_k, items) => flushed.push(items),
    });
    batcher.add(1);
    await clock.advance(50);
    expect(flushed).toHaveLength(0);
    await clock.advance(50);
    expect(flushed).toEqual([[1]]);
  });

  it('a fresh timeout starts only when a partition receives its first item', async () => {
    const clock = new ManualClock();
    const flushed: number[][] = [];
    const batcher = new Batcher<number>({
      timeoutMs: 100,
      clock,
      onFlush: (_k, items) => flushed.push(items),
    });
    batcher.add(1);
    await clock.advance(60);
    batcher.flush(); // manual flush clears the pending timer
    batcher.add(2);
    await clock.advance(60);
    expect(flushed).toEqual([[1]]); // item 2's own 100ms timeout has not elapsed yet
    await clock.advance(40);
    expect(flushed).toEqual([[1], [2]]);
  });

  it('partitions batch independently', () => {
    const flushed: { key: string; items: number[] }[] = [];
    const batcher = new Batcher<number>({
      maxEvents: 2,
      partitionKey: (n) => (n % 2 === 0 ? 'even' : 'odd'),
      onFlush: (key, items) => flushed.push({ key, items }),
    });
    batcher.add(1);
    batcher.add(2);
    batcher.add(3); // completes 'odd' (1, 3)
    expect(flushed).toEqual([{ key: 'odd', items: [1, 3] }]);
    batcher.add(4); // completes 'even' (2, 4)
    expect(flushed).toEqual([
      { key: 'odd', items: [1, 3] },
      { key: 'even', items: [2, 4] },
    ]);
  });

  it('flush() forces out whatever is pending, per partition or across all', () => {
    const flushed: number[][] = [];
    const batcher = new Batcher<number>({
      partitionKey: (n) => String(n % 2),
      onFlush: (_k, items) => flushed.push(items),
    });
    batcher.add(1);
    batcher.add(2);
    batcher.flush('1');
    expect(flushed).toEqual([[1]]);
    batcher.flush();
    expect(flushed).toEqual([[1], [2]]);
  });

  it('close() flushes everything and rejects further adds', () => {
    const flushed: number[][] = [];
    const batcher = new Batcher<number>({ onFlush: (_k, items) => flushed.push(items) });
    batcher.add(1);
    batcher.close();
    expect(flushed).toEqual([[1]]);
    expect(() => batcher.add(2)).toThrow();
    expect(batcher.isClosed).toBe(true);
  });

  it('pendingPartitions reflects partitions currently holding items', () => {
    const batcher = new Batcher<number>({
      partitionKey: (n) => String(n),
      onFlush: () => undefined,
    });
    batcher.add(1);
    batcher.add(2);
    expect(batcher.pendingPartitions).toBe(2);
    batcher.flush('1');
    expect(batcher.pendingPartitions).toBe(1);
  });

  it('never loses or duplicates an item, and never exceeds configured limits (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ value: fc.integer(), partition: fc.constantFrom('a', 'b', 'c') }), {
          maxLength: 60,
        }),
        fc.integer({ min: 1, max: 5 }),
        (items, maxEvents) => {
          const flushedByPartition = new Map<string, number[][]>();
          const batcher = new Batcher<{ value: number; partition: string }>({
            maxEvents,
            partitionKey: (item) => item.partition,
            onFlush: (key, batch) => {
              const list = flushedByPartition.get(key) ?? [];
              list.push(batch.map((b) => b.value));
              flushedByPartition.set(key, list);
              expect(batch.length).toBeLessThanOrEqual(maxEvents);
            },
          });
          for (const item of items) batcher.add(item);
          batcher.close();

          const expectedByPartition = new Map<string, number[]>();
          for (const item of items) {
            const list = expectedByPartition.get(item.partition) ?? [];
            list.push(item.value);
            expectedByPartition.set(item.partition, list);
          }
          for (const [partition, expectedValues] of expectedByPartition) {
            const flushedValues = (flushedByPartition.get(partition) ?? []).flat();
            expect(flushedValues).toEqual(expectedValues);
          }
          const totalFlushed = [...flushedByPartition.values()].flat().flat().length;
          expect(totalFlushed).toBe(items.length);
        },
      ),
    );
  });
});
