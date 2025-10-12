/**
 * A generic LRU cache used to bound the per-key state operators keep (throttle buckets, dedupe
 * fingerprints, cardinality trackers, tail-sampling decisions). Backed by a `Map`, which
 * preserves insertion order in JavaScript; touching a key re-inserts it so the map's iteration
 * order is always least-recently-used first.
 */
export interface LruOptions<V> {
  readonly maxSize: number;
  /** Called synchronously when an entry is evicted to make room for a new one. */
  onEvict?: (key: string, value: V) => void;
}

export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly options: LruOptions<V>) {
    if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
      throw new RangeError(`LruCache maxSize must be a positive integer, got ${options.maxSize}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Reads a value, marking it most-recently-used. */
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Reads a value without affecting its recency. */
  peek(key: string): V | undefined {
    return this.map.get(key);
  }

  /** Inserts or replaces a value, marking it most-recently-used, evicting if over capacity. */
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.evictOverflow();
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  /** The least-recently-used entry, if any, without removing it. */
  oldest(): [string, V] | undefined {
    const first = this.map.entries().next();
    return first.done === true ? undefined : first.value;
  }

  private evictOverflow(): void {
    while (this.map.size > this.options.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) return;
      const key = oldest.value;
      const value = this.map.get(key)!;
      this.map.delete(key);
      this.options.onEvict?.(key, value);
    }
  }
}

interface TtlEntry<V> {
  value: V;
  expiresAtMs: number;
}

/**
 * An {@link LruCache} where entries also expire after a per-entry TTL. Expiry is checked lazily
 * on read (no background timer), so callers drive time explicitly (typically `ctx.clock`),
 * which keeps this deterministic under `ManualClock` in tests.
 */
export class TtlLruCache<V> {
  private readonly lru: LruCache<TtlEntry<V>>;

  constructor(options: LruOptions<TtlEntry<V>>) {
    this.lru = new LruCache(options);
  }

  get size(): number {
    return this.lru.size;
  }

  /** Reads a value if present and not expired at `nowMs`; expired entries are removed. */
  get(key: string, nowMs: number): V | undefined {
    const entry = this.lru.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.lru.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string, nowMs: number): boolean {
    return this.get(key, nowMs) !== undefined;
  }

  set(key: string, value: V, nowMs: number, ttlMs: number): void {
    this.lru.set(key, { value, expiresAtMs: nowMs + ttlMs });
  }

  delete(key: string): boolean {
    return this.lru.delete(key);
  }

  clear(): void {
    this.lru.clear();
  }

  /** Removes every entry expired at `nowMs`. Returns the number removed. */
  evictExpired(nowMs: number): number {
    let removed = 0;
    for (const [key, entry] of [...this.lru.entries()]) {
      if (entry.expiresAtMs <= nowMs) {
        this.lru.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
