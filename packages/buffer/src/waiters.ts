import { BufferAbortedError } from './errors.js';

/** A pending call registered in a waiter list, woken by {@link wakeAll}. */
export interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** Wakes every waiter currently in `waiters` and empties the list. */
export function wakeAll(waiters: Waiter[]): void {
  const toWake = waiters.splice(0);
  for (const w of toWake) {
    w.cleanup();
    w.resolve();
  }
}

/**
 * Registers a waiter in `waiters` and returns a promise that resolves the next time
 * {@link wakeAll} is called, or rejects with {@link BufferAbortedError} if `signal` aborts first.
 */
export function waitFor(waiters: Waiter[], signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BufferAbortedError());
      return;
    }
    const onAbort = (): void => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      reject(new BufferAbortedError());
    };
    const waiter: Waiter = {
      resolve,
      reject,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    };
    waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
