interface Waiter {
  readonly grant: () => void;
  readonly fail: (reason: unknown) => void;
}

function waitForSlot(waiters: Waiter[], signal: AbortSignal | undefined): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
  if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const waiter: Waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      fail: (reason) => {
        if (settled) return;
        settled = true;
        cleanup();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(reason);
      },
    };
    const onAbort = (): void => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      waiter.fail(signal!.reason as unknown);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

/** Bounds how many operations run at once. {@link acquire} resolves with a release function. */
export interface ConcurrencyLimiter {
  acquire(signal?: AbortSignal): Promise<() => void>;
  readonly limit: number;
  readonly inFlight: number;
}

/** A limiter with a constant, caller-chosen concurrency ceiling. */
export class FixedConcurrencyLimiter implements ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) throw new RangeError('maxConcurrency must be at least 1');
  }

  get limit(): number {
    return this.maxConcurrency;
  }

  get inFlight(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.maxConcurrency) await waitForSlot(this.waiters, signal);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      next?.grant();
    };
  }
}

export interface AdaptiveConcurrencyOptions {
  /** Starting concurrency ceiling. Default 4. */
  readonly initialLimit?: number;
  readonly minLimit?: number;
  readonly maxLimit?: number;
  /** A completion slower than this counts as a signal to back off. Default: never (only errors matter). */
  readonly latencyThresholdMs?: number;
  /** Multiplicative decrease applied to the limit on error or high latency. Default 0.5. */
  readonly decreaseFactor?: number;
  /** Consecutive good completions required before the limit grows by 1. Default 10. */
  readonly increaseAfter?: number;
}

/**
 * An AIMD (additive-increase, multiplicative-decrease) concurrency limiter: the ceiling grows by
 * one after a run of good completions and shrinks multiplicatively on an error or a completion
 * slower than {@link AdaptiveConcurrencyOptions.latencyThresholdMs}. Callers must call
 * {@link report} once per completed operation for the limit to adapt.
 */
export class AdaptiveConcurrencyLimiter implements ConcurrencyLimiter {
  private currentLimit: number;
  private active = 0;
  private goodStreak = 0;
  private readonly waiters: Waiter[] = [];
  private readonly minLimit: number;
  private readonly maxLimit: number;

  constructor(private readonly options: AdaptiveConcurrencyOptions = {}) {
    this.minLimit = Math.max(1, options.minLimit ?? 1);
    this.maxLimit = Math.max(this.minLimit, options.maxLimit ?? 256);
    this.currentLimit = clamp(Math.round(options.initialLimit ?? 4), this.minLimit, this.maxLimit);
  }

  get limit(): number {
    return Math.max(1, Math.round(this.currentLimit));
  }

  get inFlight(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) await waitForSlot(this.waiters, signal);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  /** Reports how one operation went so the limit can adapt for subsequent acquisitions. */
  report(outcome: { success: boolean; latencyMs: number }): void {
    const slow =
      this.options.latencyThresholdMs !== undefined &&
      outcome.latencyMs > this.options.latencyThresholdMs;
    if (!outcome.success || slow) {
      this.goodStreak = 0;
      this.currentLimit = clamp(
        this.currentLimit * (this.options.decreaseFactor ?? 0.5),
        this.minLimit,
        this.maxLimit,
      );
    } else {
      this.goodStreak++;
      const threshold = this.options.increaseAfter ?? 10;
      if (this.goodStreak >= threshold) {
        this.goodStreak = 0;
        this.currentLimit = clamp(this.currentLimit + 1, this.minLimit, this.maxLimit);
      }
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      this.active++;
      this.waiters.shift()!.grant();
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
