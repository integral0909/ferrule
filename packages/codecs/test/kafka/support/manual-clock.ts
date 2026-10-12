import type { KafkaConsumerClock } from '../../../src/kafka/consumer.js';

/**
 * A deterministic stand-in for `KafkaConsumerClock`, used by both `KafkaConsumer` (its
 * heartbeat loop) and the fake group-coordinator broker's own session-timeout sweep in these
 * tests, so "a member stops heartbeating and its session times out" is driven by an explicit
 * `advance()` call rather than real wall-clock time. Mirrors the shape (`now()`, and an
 * `advance()`/`pendingCount` pair for driving pending sleeps) of `@ferrule/runtime`'s own
 * `ManualClock`, which this package cannot import (`@ferrule/codecs` must not depend on
 * `@ferrule/runtime`, a higher layer) — this is a small, self-contained equivalent scoped to
 * what `KafkaConsumerClock` actually needs.
 */
export class ManualClock implements KafkaConsumerClock {
  private currentMs = 0;
  private readonly pending: {
    readonly deadline: number;
    readonly resolve: () => void;
    readonly cleanup: () => void;
  }[] = [];

  now(): number {
    return this.currentMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
      return Promise.reject(signal.reason as unknown);
    }
    return new Promise<void>((resolve, reject) => {
      const deadline = this.currentMs + ms;
      const onAbort = (): void => {
        const index = this.pending.findIndex((entry) => entry.resolve === resolveOnce);
        if (index !== -1) this.pending.splice(index, 1);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(signal!.reason as unknown);
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      const resolveOnce = (): void => {
        cleanup();
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.push({ deadline, resolve: resolveOnce, cleanup });
    });
  }

  /** Advances time by `ms`, resolving every pending `sleep()` whose deadline that crosses, in
   * deadline order, yielding a microtask turn between each so a resolved sleep's continuation
   * (e.g. the heartbeat loop sending its next request) runs before the next one resolves. */
  async advance(ms: number): Promise<void> {
    this.currentMs += ms;
    const due = this.pending.filter((entry) => entry.deadline <= this.currentMs);
    due.sort((a, b) => a.deadline - b.deadline);
    for (const entry of due) {
      const index = this.pending.indexOf(entry);
      if (index !== -1) this.pending.splice(index, 1);
      entry.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

/**
 * Wraps a {@link ManualClock} so `sleep()` can be switched, mid-test, to never resolve again —
 * simulating a consumer's background heartbeat loop simply stopping (a crashed process, a
 * deadlocked thread) without touching the shared clock `now()` continues to read from, so a
 * member can heartbeat normally during test setup and only "go silent" from a chosen point
 * onward. `KafkaConsumer.close()` always sends a clean `LeaveGroup`, so it cannot simulate this
 * on its own — a real silent failure never gets the chance to say goodbye.
 */
export class FreezableClock implements KafkaConsumerClock {
  private frozen = false;

  constructor(private readonly inner: ManualClock) {}

  now(): number {
    return this.inner.now();
  }

  /** From this point on, every `sleep()` call (including ones already pending) never resolves. */
  freeze(): void {
    this.frozen = true;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.frozen) return new Promise<void>(() => undefined);
    return this.inner.sleep(ms, signal);
  }
}
