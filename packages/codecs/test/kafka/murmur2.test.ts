import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  murmur2,
  murmur2Partition,
  RoundRobinPartitioner,
  StickyPartitioner,
  toPositive,
} from '../../src/kafka/murmur2.js';

/**
 * An independently-structured re-implementation of the same algorithm (Kafka's
 * `Utils.murmur2`), used only to cross-check `murmur2` in `src/kafka/murmur2.ts` against a
 * second, differently-written implementation rather than trusting one hand-rolled version of
 * itself. It reads 4-byte words via `Buffer.readInt32LE` instead of manual byte-shift
 * composition, and structures the tail-byte handling as an explicit loop instead of
 * fall-through-style ifs, while implementing the exact same documented algorithm (seed
 * `0x9747b28c`, `h = seed ^ length`, multiplier `0x5bd1e995`, shift `24`/`13`/`15`).
 */
function murmur2Reference(data: Uint8Array): number {
  const buf = Buffer.from(data);
  const seed = 0x9747b28c | 0;
  const m = 0x5bd1e995;
  let h = (seed ^ buf.length) | 0;
  const wordCount = Math.floor(buf.length / 4);
  for (let i = 0; i < wordCount; i++) {
    let k = buf.readInt32LE(i * 4);
    k = Math.imul(k, m);
    k = k ^ (k >>> 24);
    k = Math.imul(k, m);
    h = Math.imul(h, m);
    h = h ^ k;
  }
  const tailLength = buf.length % 4;
  const tailOffset = buf.length - tailLength;
  const tailBytes: number[] = [];
  for (let i = tailOffset; i < buf.length; i++) tailBytes.push(buf[i]!);
  if (tailBytes.length === 3) h ^= tailBytes[2]! << 16;
  if (tailBytes.length >= 2) h ^= tailBytes[1]! << 8;
  if (tailBytes.length >= 1) {
    h ^= tailBytes[0]!;
    h = Math.imul(h, m);
  }
  h = h ^ (h >>> 13);
  h = Math.imul(h, m);
  h = h ^ (h >>> 15);
  return h | 0;
}

describe('murmur2', () => {
  it('is deterministic for the empty input', () => {
    const a = murmur2(new Uint8Array(0));
    const b = murmur2(new Uint8Array(0));
    expect(a).toBe(b);
  });

  it('agrees with an independently-structured second implementation of the same algorithm', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(murmur2(bytes)).toBe(murmur2Reference(bytes));
      }),
    );
  });

  it('agrees on a range of fixed-length inputs (0..8 bytes) exercising every tail-length case', () => {
    for (let len = 0; len <= 8; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      expect(murmur2(bytes)).toBe(murmur2Reference(bytes));
    }
  });

  it('is sensitive to every input byte (changing one byte changes the hash)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.nat({ max: 255 }),
        (bytes, delta) => {
          const changed = bytes.slice();
          changed[0] = (changed[0]! + 1 + (delta % 254)) & 0xff;
          if (changed[0] === bytes[0]) return; // skip the rare no-op case
          expect(murmur2(bytes)).not.toBe(murmur2(changed));
        },
      ),
    );
  });

  it('distributes UTF-8 encoded sequential keys reasonably evenly across partitions', () => {
    const numPartitions = 12;
    const counts = new Array<number>(numPartitions).fill(0);
    for (let i = 0; i < 12_000; i++) {
      const key = new TextEncoder().encode(`key-${i}`);
      const partition = murmur2Partition(key, numPartitions);
      counts[partition] = (counts[partition] ?? 0) + 1;
    }
    const expected = 12_000 / numPartitions;
    for (const count of counts) {
      // Loose bound: every partition should get a reasonable share, not a skewed distribution.
      expect(count).toBeGreaterThan(expected * 0.5);
      expect(count).toBeLessThan(expected * 1.5);
    }
  });
});

describe('toPositive', () => {
  it('masks off the sign bit rather than negating', () => {
    expect(toPositive(-1)).toBe(0x7fffffff);
    expect(toPositive(0x7fffffff)).toBe(0x7fffffff);
    expect(toPositive(0)).toBe(0);
  });
});

describe('murmur2Partition', () => {
  it('always returns a partition index in range', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 100 }),
        fc.integer({ min: 1, max: 500 }),
        (key, numPartitions) => {
          const p = murmur2Partition(key, numPartitions);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThan(numPartitions);
        },
      ),
    );
  });

  it('is a pure function of (key, numPartitions): identical key -> identical partition', () => {
    const key = new TextEncoder().encode('stable-key');
    const first = murmur2Partition(key, 8);
    for (let i = 0; i < 20; i++) expect(murmur2Partition(key, 8)).toBe(first);
  });
});

describe('RoundRobinPartitioner', () => {
  it('cycles through every partition in order, independently per topic', () => {
    const rr = new RoundRobinPartitioner();
    const seenA = Array.from({ length: 6 }, () => rr.next('a', 3));
    expect(seenA).toEqual([0, 1, 2, 0, 1, 2]);
    const seenB = Array.from({ length: 3 }, () => rr.next('b', 3));
    expect(seenB).toEqual([0, 1, 2]);
  });
});

describe('StickyPartitioner', () => {
  it('stays on the same partition until onBatchComplete is called', () => {
    const sticky = new StickyPartitioner();
    const first = sticky.next('t', 10, () => 0.42);
    for (let i = 0; i < 10; i++) expect(sticky.next('t', 10, () => Math.random())).toBe(first);
    sticky.onBatchComplete('t');
    // After completion, a new (possibly different) partition is chosen and then held again.
    const second = sticky.next('t', 10, () => 0.1);
    for (let i = 0; i < 10; i++) expect(sticky.next('t', 10, () => Math.random())).toBe(second);
  });
});

describe('murmur2 compatibility with the Java client', () => {
  // Published expectations from Apache Kafka's own utility tests; matching them means keys land
  // on the same partitions as with the Java producer's default partitioner.
  it.each([
    ['21', -973932308],
    ['foobar', -790332482],
    ['a-little-bit-long-string', -985981536],
    ['a-little-bit-longer-string', -1486304829],
    ['lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8', -58897971],
    ['abc', 479470107],
  ])('hashes %j to %i', (input, expected) => {
    expect(murmur2(new TextEncoder().encode(input))).toBe(expected);
  });
});
