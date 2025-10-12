import { ALT_SEED, hashString } from './hash.js';

/**
 * A fixed-size Bloom filter used by `cardinality_limit`'s probabilistic mode to bound the
 * memory used to track distinct tag combinations. Unlike a HyperLogLog, a Bloom filter answers
 * "have I seen this exact value before", which is what a limiter needs to decide whether a new
 * combination should count against the limit; the trade-off is a bounded false-positive rate
 * (an unseen combination is occasionally reported as seen) instead of an exact answer, in
 * exchange for `O(bits)` memory instead of `O(distinct values)`.
 *
 * Bit indices are derived from two independent 64-bit hashes combined with the standard
 * Kirsch–Mitzenmacher technique (`g_i(x) = h1(x) + i * h2(x)`), which is statistically as good
 * as `k` independent hash functions without computing `k` of them.
 */
export class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly bitCount: number;
  private readonly hashCount: number;

  /**
   * @param expectedItems Approximate number of distinct items the filter will hold.
   * @param falsePositiveRate Target false-positive probability at `expectedItems`, e.g. `0.01`.
   */
  constructor(expectedItems: number, falsePositiveRate: number) {
    const n = Math.max(1, expectedItems);
    const p = Math.min(0.5, Math.max(1e-6, falsePositiveRate));
    const bitCount = Math.ceil((-n * Math.log(p)) / (Math.LN2 * Math.LN2));
    this.bitCount = Math.max(64, bitCount);
    this.hashCount = Math.max(1, Math.min(32, Math.round((this.bitCount / n) * Math.LN2)));
    this.bits = new Uint8Array(Math.ceil(this.bitCount / 8));
  }

  private indices(key: string): number[] {
    const h1 = hashString(key);
    const h2 = hashString(key, ALT_SEED) | 1n; // odd, so it never degenerates to 0
    const m = BigInt(this.bitCount);
    const out: number[] = [];
    let combined = h1 % m;
    const step = h2 % m;
    for (let i = 0; i < this.hashCount; i++) {
      out.push(Number(combined < 0n ? combined + m : combined));
      combined = (combined + step) % m;
    }
    return out;
  }

  /** Adds `key`. Idempotent. */
  add(key: string): void {
    for (const i of this.indices(key)) {
      this.bits[i >> 3]! |= 1 << (i & 7);
    }
  }

  /** True if `key` was (probably) added before; false negatives never happen. */
  has(key: string): boolean {
    for (const i of this.indices(key)) {
      if ((this.bits[i >> 3]! & (1 << (i & 7))) === 0) return false;
    }
    return true;
  }

  /** Adds `key` and reports whether it was probably new (i.e. `has` was false beforehand). */
  addIfAbsent(key: string): boolean {
    const isNew = !this.has(key);
    this.add(key);
    return isNew;
  }

  get sizeBits(): number {
    return this.bitCount;
  }

  get hashFunctionCount(): number {
    return this.hashCount;
  }
}
