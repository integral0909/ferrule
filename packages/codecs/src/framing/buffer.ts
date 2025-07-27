/**
 * An append-only byte buffer that grows by doubling and can drop already-consumed bytes from its
 * front in place. Used internally by framers to accumulate bytes across `push` calls without
 * re-allocating on every chunk.
 */
export class AppendBuffer {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(Math.max(1, initialCapacity));
  }

  get length(): number {
    return this.len;
  }

  /** A view over the currently buffered bytes. Do not retain past the next mutation. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const needed = this.len + chunk.length;
    if (needed > this.buf.length) {
      let capacity = this.buf.length * 2;
      while (capacity < needed) capacity *= 2;
      const next = new Uint8Array(capacity);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len = needed;
  }

  /** Drops the first `n` bytes, shifting the remainder to the front. */
  consume(n: number): void {
    if (n <= 0) return;
    if (n >= this.len) {
      this.len = 0;
      return;
    }
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }

  clear(): void {
    this.len = 0;
  }
}
