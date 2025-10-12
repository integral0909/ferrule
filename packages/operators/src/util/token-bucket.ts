/**
 * A continuous-refill token bucket: `capacity` tokens, refilled at `refillPerMs` tokens per
 * millisecond, driven by an externally supplied monotonic clock reading (typically
 * `ctx.clock.monotonic()`) so it is deterministic under `ManualClock` in tests.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    nowMs: number,
    startFull = true,
  ) {
    this.tokens = startFull ? capacity : 0;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = nowMs;
  }

  /** Attempts to remove `n` tokens. Returns whether enough were available. */
  tryRemove(n: number, nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Current token count as of `nowMs` (refills first), without consuming any. */
  peek(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }
}

/** Builds the per-millisecond refill rate for "N events per window of `windowMs`". */
export function refillRatePerMs(eventsPerWindow: number, windowMs: number): number {
  return eventsPerWindow / windowMs;
}
