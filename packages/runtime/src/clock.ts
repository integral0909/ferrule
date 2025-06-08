import { Timestamp } from '@ferrule/core';
import type { Clock } from './component.js';

/** {@link Clock} backed by the real wall clock and real timers. */
export class SystemClock implements Clock {
  now(): Timestamp {
    return Timestamp.now();
  }

  monotonic(): number {
    return performance.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
    if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(signal!.reason as unknown);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

interface PendingSleep {
  readonly id: number;
  /** Monotonic time (in the manual clock's own units) at which this sleep should resolve. */
  readonly dueAt: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  cancelled: boolean;
}

let sleepIdCounter = 0;

/**
 * A deterministic {@link Clock} for tests. Time only moves when {@link advance} or {@link tick}
 * is called; pending sleeps resolve in the order their deadlines are crossed, and code they
 * trigger (including new sleeps scheduled from within a resolved sleep) is given a chance to run
 * before the next deadline is considered, so chained timeouts behave as they would with real
 * timers.
 */
export class ManualClock implements Clock {
  private wallNanos: bigint;
  private monoMs: number;
  private readonly pending: PendingSleep[] = [];

  constructor(options: { startNanos?: bigint; startMonotonicMs?: number } = {}) {
    this.wallNanos = options.startNanos ?? 0n;
    this.monoMs = options.startMonotonicMs ?? 0;
  }

  now(): Timestamp {
    return Timestamp.fromNanos(this.wallNanos);
  }

  monotonic(): number {
    return this.monoMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
    if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(
        new RangeError(`sleep duration must be finite and non-negative, got ${ms}`),
      );
    }
    if (ms === 0) return Promise.resolve();
    const dueAt = this.monoMs + ms;
    return new Promise<void>((resolve, reject) => {
      const entry: PendingSleep = {
        id: sleepIdCounter++,
        dueAt,
        resolve,
        reject,
        cancelled: false,
      };
      this.pending.push(entry);
      const onAbort = (): void => {
        entry.cancelled = true;
        removeFromPending(this.pending, entry);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(signal!.reason as unknown);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Number of sleeps currently waiting to be resolved. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Advances both the monotonic and wall clocks by `ms`, resolving every pending sleep whose
   * deadline falls at or before the new time, in deadline order (ties broken by scheduling
   * order). Yields to the microtask queue between each resolution so callbacks can observe an
   * up-to-date clock and schedule further sleeps.
   */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance duration must be finite and non-negative, got ${ms}`);
    }
    const target = this.monoMs + ms;
    for (;;) {
      let next: PendingSleep | undefined;
      for (const entry of this.pending) {
        if (entry.dueAt > target) continue;
        if (
          next === undefined ||
          entry.dueAt < next.dueAt ||
          (entry.dueAt === next.dueAt && entry.id < next.id)
        ) {
          next = entry;
        }
      }
      if (next === undefined) break;
      removeFromPending(this.pending, next);
      this.advanceTo(next.dueAt);
      next.resolve();
      // Let resolved continuations (and anything they schedule) run before the next deadline.
      await flushMicrotasks();
    }
    this.advanceTo(target);
  }

  /** Moves the clock directly to an absolute monotonic time, without resolving any sleeps. */
  private advanceTo(monoMs: number): void {
    const deltaMs = monoMs - this.monoMs;
    if (deltaMs <= 0) return;
    this.monoMs = monoMs;
    this.wallNanos += BigInt(Math.round(deltaMs * 1e6));
  }

  /**
   * Advances directly to the next pending sleep's deadline and resolves it. No-op if nothing is
   * pending. Returns whether a sleep was resolved.
   */
  async tick(): Promise<boolean> {
    let next: PendingSleep | undefined;
    for (const entry of this.pending) {
      if (
        next === undefined ||
        entry.dueAt < next.dueAt ||
        (entry.dueAt === next.dueAt && entry.id < next.id)
      ) {
        next = entry;
      }
    }
    if (next === undefined) return false;
    const delta = Math.max(0, next.dueAt - this.monoMs);
    await this.advance(delta);
    return true;
  }
}

function removeFromPending(pending: PendingSleep[], entry: PendingSleep): void {
  const index = pending.indexOf(entry);
  if (index !== -1) pending.splice(index, 1);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
