import type { PathSegment, Value, ValueMap } from '@ferrule/core';

/**
 * Generalized path read/write for an arbitrary {@link Value} root (not just an event's object
 * root, which is all `@ferrule/core`'s `path.ts` supports). Two callers need this:
 *
 * - the compiler, for assigning through a local variable's field/index chain (`x.a[0] = v`,
 *   where `x` may hold any container-shaped value, not necessarily an object);
 * - the `get`/`set`/`del`/`exists` (path-array form) standard library functions, which walk a
 *   runtime array of segments over any value, not the event.
 *
 * Semantics mirror `@ferrule/core`'s `getPath`/`setPath`: reads return `undefined` for a missing
 * or wrong-kind step; writes create intermediate objects/arrays as needed, choosing object vs.
 * array from the *next* segment's kind, and replace an intermediate of the wrong kind.
 */

function resolveIndex(length: number, index: number): number {
  return index < 0 ? length + index : index;
}

export function getInValue(root: Value, segments: readonly PathSegment[]): Value | undefined {
  let current: Value | undefined = root;
  for (const seg of segments) {
    if (typeof seg === 'string') {
      current = current instanceof Map ? current.get(seg) : undefined;
    } else {
      if (!Array.isArray(current)) return undefined;
      const i = resolveIndex(current.length, seg);
      current = i >= 0 && i < current.length ? current[i] : undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

export function hasInValue(root: Value, segments: readonly PathSegment[]): boolean {
  return getInValue(root, segments) !== undefined;
}

/**
 * Writes `value` at `segments` under `root`, creating intermediate containers as needed, and
 * returns the (possibly new) root. Unlike `@ferrule/core`'s `setPath`, `root` itself may need to
 * become a fresh container (a local variable's initial value need not be an object), which is why
 * this returns the root rather than mutating a fixed one; a single-segment path with a container
 * `root` mutates in place and returns the same reference.
 */
export function setInValue(root: Value, segments: readonly PathSegment[], value: Value): Value {
  if (segments.length === 0) return value;
  const rootContainer = ensureContainer(root, segments[0]!);
  let container: Value[] | ValueMap = rootContainer;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const nextSeg = segments[i + 1]!;
    const child = ensureContainer(readSlot(container, seg), nextSeg);
    writeSlot(container, seg, child);
    container = child;
  }
  writeSlot(container, segments[segments.length - 1]!, value);
  return rootContainer;
}

/** Removes the value at `segments` and returns it, or `undefined` if nothing was there. */
export function deleteInValue(root: Value, segments: readonly PathSegment[]): Value | undefined {
  if (segments.length === 0) return undefined;
  const parent = getInValue(root, segments.slice(0, -1));
  const last = segments[segments.length - 1]!;
  if (typeof last === 'string') {
    if (!(parent instanceof Map)) return undefined;
    const removed = parent.get(last);
    parent.delete(last);
    return removed;
  }
  if (!Array.isArray(parent)) return undefined;
  const i = resolveIndex(parent.length, last);
  if (i < 0 || i >= parent.length) return undefined;
  return parent.splice(i, 1)[0];
}

function ensureContainer(value: Value | undefined, nextSeg: PathSegment): Value[] | ValueMap {
  if (typeof nextSeg === 'number') return Array.isArray(value) ? value : [];
  return value instanceof Map ? value : new Map<string, Value>();
}

function readSlot(container: Value[] | ValueMap, seg: PathSegment): Value | undefined {
  if (typeof seg === 'string') return container instanceof Map ? container.get(seg) : undefined;
  if (!Array.isArray(container)) return undefined;
  const i = resolveIndex(container.length, seg);
  return i >= 0 && i < container.length ? container[i] : undefined;
}

function writeSlot(container: Value[] | ValueMap, seg: PathSegment, value: Value): void {
  if (container instanceof Map) {
    container.set(seg as string, value);
    return;
  }
  const i = resolveIndex(container.length, seg as number);
  while (container.length < i) container.push(null);
  container[i] = value;
}

/**
 * Converts a runtime {@link Value} (an array of strings/ints, as produced by the script's array
 * literals) into a `PathSegment` array for the path-array standard library functions. Returns
 * `undefined` if `value` is not an array of strings/ints.
 */
export function toPathSegments(value: Value): readonly PathSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments: PathSegment[] = [];
  for (const el of value) {
    if (typeof el === 'string') segments.push(el);
    else if (typeof el === 'bigint') segments.push(Number(el));
    else return undefined;
  }
  return segments;
}
