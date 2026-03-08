/**
 * An injectable debounce scheduler. Diagnostics recompute on every keystroke's `didChange`, which
 * would otherwise mean re-parsing and re-checking on every character; {@link Scheduler} lets
 * `server.ts` coalesce bursts of edits to the same document into one publish, while keeping the
 * timing mechanism swappable so tests can drive it deterministically instead of waiting on real
 * timers.
 */

export interface Scheduler {
  /** (Re-)schedules `fn` to run after `delayMs`, replacing any pending run still queued for `key`. */
  schedule(key: string, delayMs: number, fn: () => void): void;
  /** Cancels a pending run for `key`, if any. */
  cancel(key: string): void;
  /** Cancels every pending run. */
  dispose(): void;
}

/** The production scheduler: plain `setTimeout`/`clearTimeout`. */
export function createTimeoutScheduler(): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(key, delayMs, fn) {
      const existing = timers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fn();
        }, delayMs),
      );
    },
    cancel(key) {
      const existing = timers.get(key);
      if (existing === undefined) return;
      clearTimeout(existing);
      timers.delete(key);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/**
 * A scheduler that runs `fn` synchronously and immediately, ignoring `delayMs`. Useful for tests
 * that want every diagnostics publish to happen inline, with no debounce window to account for.
 */
export function createImmediateScheduler(): Scheduler {
  return {
    schedule(_key, _delayMs, fn) {
      fn();
    },
    cancel() {},
    dispose() {},
  };
}

/**
 * A scheduler tests control by hand: {@link ManualScheduler.flush} runs every pending callback
 * (in schedule order) regardless of its delay, so a test can assert "no diagnostics published yet"
 * right after an edit and then "published now" after an explicit flush.
 */
export class ManualScheduler implements Scheduler {
  private readonly pending = new Map<string, () => void>();

  schedule(key: string, _delayMs: number, fn: () => void): void {
    this.pending.set(key, fn);
  }

  cancel(key: string): void {
    this.pending.delete(key);
  }

  dispose(): void {
    this.pending.clear();
  }

  get pendingKeys(): readonly string[] {
    return [...this.pending.keys()];
  }

  flush(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const fn of callbacks) fn();
  }
}
