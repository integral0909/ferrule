import type { Clock } from './component.js';

/**
 * Structural equality good enough for diffing component options: primitives, arrays, `Map`s,
 * `Set`s, `RegExp`s, `Date`s, and plain objects, compared recursively. Property order and `Map`
 * key insertion order do not matter.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof RegExp || b instanceof RegExp) {
    return (
      a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags
    );
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) {
      let found = false;
      for (const w of b) {
        if (deepEqual(v, w)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bRecord, key) || !deepEqual(aRecord[key], bRecord[key])) return false;
  }
  return true;
}

/** Serializes async operations that must not interleave (a transform's `process`/`tick`/`flush`). */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Awaits `promise` but resolves with `true` (without waiting further) if `ms` elapses first,
 * using `clock` so tests can control the deadline deterministically. `promise` is not cancelled;
 * the caller decides what to do once it knows the deadline was hit.
 */
export async function timedOut(
  promise: Promise<unknown>,
  ms: number,
  clock: Clock,
): Promise<boolean> {
  const controller = new AbortController();
  let expired = false;
  const timeout = clock
    .sleep(ms, controller.signal)
    .then(() => {
      expired = true;
    })
    .catch(() => undefined);
  await Promise.race([
    promise.then(() => controller.abort()).catch(() => controller.abort()),
    timeout,
  ]);
  return expired;
}
