export interface RetryPolicyOptions {
  /** Base delay before the first retry, in milliseconds. Default 100. */
  readonly initialDelayMs?: number;
  /** Ceiling the exponential backoff is capped at. Default 30000. */
  readonly maxDelayMs?: number;
  /** Growth factor applied per attempt. Default 2. */
  readonly multiplier?: number;
  /** Give up after this many attempts. Default unbounded. */
  readonly maxAttempts?: number;
  /** Give up once this much time has elapsed since the first attempt. Default unbounded. */
  readonly maxElapsedMs?: number;
  /** Source of randomness for jitter. Overridable for deterministic tests. */
  readonly random?: () => number;
}

export interface RetryDecision {
  readonly shouldRetry: boolean;
  /** Milliseconds to wait before the next attempt. Meaningless when `shouldRetry` is false. */
  readonly delayMs: number;
}

/**
 * Exponential backoff with full jitter (`delay = random(0, min(maxDelay, initial * multiplier ^
 * (attempt - 1)))`, per the AWS architecture blog's "full jitter" recommendation), bounded by a
 * maximum attempt count and/or elapsed time.
 */
export class RetryPolicy {
  constructor(private readonly options: RetryPolicyOptions = {}) {}

  /**
   * Decides whether to retry after `attempt` (the 1-based attempt number that just failed) has
   * failed `elapsedMs` after the first attempt began. If the failure carried a server-provided
   * minimum (`retryAfterMs`), the computed delay is never shorter than it.
   */
  next(attempt: number, elapsedMs: number, retryAfterMs?: number): RetryDecision {
    const maxAttempts = this.options.maxAttempts ?? Infinity;
    const maxElapsedMs = this.options.maxElapsedMs ?? Infinity;
    if (attempt >= maxAttempts || elapsedMs >= maxElapsedMs) {
      return { shouldRetry: false, delayMs: 0 };
    }
    const initial = this.options.initialDelayMs ?? 100;
    const max = this.options.maxDelayMs ?? 30_000;
    const multiplier = this.options.multiplier ?? 2;
    const cap = Math.min(max, initial * multiplier ** (attempt - 1));
    const random = this.options.random ?? Math.random;
    const jittered = random() * cap;
    const delayMs = retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered;
    return { shouldRetry: true, delayMs };
  }
}
