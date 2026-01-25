/**
 * MurmurHash2 as used by Kafka's default (Java client-compatible) partitioner:
 * `org.apache.kafka.common.utils.Utils.murmur2(byte[])`. This is the classic Austin Appleby
 * MurmurHash2 algorithm with Kafka's specific seed (`0x9747b28c`) and initialisation
 * (`h = seed ^ length`), reproduced here bit-for-bit (including Java's 32-bit signed integer
 * overflow semantics, via `Math.imul`) so that producing to the same topic/partition from
 * Ferrule and from a Java (or any Kafka-protocol-compatible) producer picks the same partition
 * for the same key.
 */

const SEED = 0x9747b28c | 0;
const M = 0x5bd1e995;
const R = 24;

/** Computes Kafka's `murmur2(bytes)`, returning a signed 32-bit integer (may be negative; see
 * {@link toPositivePartition} for the partitioner's own masking). */
export function murmur2(data: Uint8Array): number {
  const length = data.length;
  let h = (SEED ^ length) | 0;
  const length4 = length >> 2;

  for (let i = 0; i < length4; i++) {
    const i4 = i * 4;
    let k =
      (data[i4]! & 0xff) |
      ((data[i4 + 1]! & 0xff) << 8) |
      ((data[i4 + 2]! & 0xff) << 16) |
      ((data[i4 + 3]! & 0xff) << 24);
    k = Math.imul(k, M);
    k ^= k >>> R;
    k = Math.imul(k, M);
    h = Math.imul(h, M);
    h ^= k;
  }

  const remainder = length & 3;
  const tailStart = length - remainder;
  if (remainder === 3) h ^= (data[tailStart + 2]! & 0xff) << 16;
  if (remainder >= 2) h ^= (data[tailStart + 1]! & 0xff) << 8;
  if (remainder >= 1) {
    h ^= data[tailStart]! & 0xff;
    h = Math.imul(h, M);
  }

  h ^= h >>> 13;
  h = Math.imul(h, M);
  h ^= h >>> 15;

  return h | 0;
}

/** Kafka's `Utils.toPositive`: masks off the sign bit rather than taking an absolute value (so
 * `Int32.MIN_VALUE` does not misbehave). */
export function toPositive(n: number): number {
  return n & 0x7fffffff;
}

/** The classic Kafka default partitioner's choice for a keyed record: `toPositive(murmur2(key))
 * % numPartitions`. */
export function murmur2Partition(key: Uint8Array, numPartitions: number): number {
  if (numPartitions <= 0) throw new RangeError('numPartitions must be positive');
  return toPositive(murmur2(key)) % numPartitions;
}

// -------------------------------------------------------------------------------------------
// Partitioning strategies for unkeyed records
// -------------------------------------------------------------------------------------------

/** Plain round-robin: cycles through every partition in order, one record at a time. */
export class RoundRobinPartitioner {
  private counters = new Map<string, number>();

  next(topic: string, numPartitions: number): number {
    const current = this.counters.get(topic) ?? 0;
    this.counters.set(topic, (current + 1) % numPartitions);
    return current % numPartitions;
  }
}

/** The "sticky" partitioner (KIP-480): stays on one randomly-chosen partition for a whole batch
 * (until the caller calls {@link StickyPartitioner.onBatchComplete}), which produces fewer,
 * larger batches per partition than plain round-robin for unkeyed records under a batching
 * sink — the caller decides when a "batch" ends (for this sink, once per flushed batch). */
export class StickyPartitioner {
  private current = new Map<string, number>();

  next(topic: string, numPartitions: number, random: () => number = Math.random): number {
    let partition = this.current.get(topic);
    if (partition === undefined || partition >= numPartitions) {
      partition = Math.floor(random() * numPartitions);
      this.current.set(topic, partition);
    }
    return partition;
  }

  onBatchComplete(topic: string): void {
    this.current.delete(topic);
  }
}
