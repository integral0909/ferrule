import { ParseError } from './errors.js';
import type { Value, ValueMap } from './value.js';

/**
 * One step in a field path: a `string` selects an object field, a `number` selects an array
 * element. Negative indices count from the end (`-1` is the last element).
 */
export type PathSegment = string | number;

/** A parsed field path. The empty path refers to the root. */
export type Path = readonly PathSegment[];

const IDENT_CHAR = /[A-Za-z0-9_@]/;
const IDENTIFIER = /^[A-Za-z0-9_@]+$/;

/**
 * Parses a field path.
 *
 * Grammar:
 * ```
 * path     = "." | [ "." ] step ( ("." step) | index )*
 * step     = ident | quoted
 * ident    = [A-Za-z0-9_@]+
 * quoted   = '"' JSON-string-contents '"'
 * index    = "[" "-"? digits "]"
 * ```
 * Examples: `.`, `.message`, `.http.request.headers."user-agent"`, `.items[0].id`, `.tags[-1]`.
 * The leading `.` is optional so configuration can say `message` instead of `.message`.
 */
export function parsePath(text: string): Path {
  if (text === '.' || text === '') return [];
  const segments: PathSegment[] = [];
  let pos = 0;
  const n = text.length;

  const fail = (message: string): never => {
    throw new ParseError('E_PATH_SYNTAX', `invalid path ${JSON.stringify(text)}: ${message}`, pos);
  };

  const readField = (): void => {
    if (text[pos] === '"') {
      segments.push(readQuoted());
      return;
    }
    const start = pos;
    while (pos < n && IDENT_CHAR.test(text[pos]!)) pos++;
    if (pos === start) fail('expected a field name');
    segments.push(text.slice(start, pos));
  };

  const readQuoted = (): string => {
    const start = pos;
    pos++; // opening quote
    let escaped = false;
    while (pos < n) {
      const c = text[pos]!;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') break;
      pos++;
    }
    if (pos >= n) fail('unterminated quoted field name');
    pos++; // closing quote
    try {
      return JSON.parse(text.slice(start, pos)) as string;
    } catch {
      pos = start;
      return fail('invalid escape in quoted field name');
    }
  };

  const readIndex = (): void => {
    pos++; // [
    const start = pos;
    if (text[pos] === '-') pos++;
    const digitsStart = pos;
    while (pos < n && text.charCodeAt(pos) >= 48 && text.charCodeAt(pos) <= 57) pos++;
    if (pos === digitsStart) fail('expected an array index');
    if (text[pos] !== ']') fail('expected "]"');
    const index = Number(text.slice(start, pos));
    if (!Number.isSafeInteger(index)) fail('array index out of range');
    segments.push(index);
    pos++; // ]
  };

  if (text[0] === '.') pos = 1;
  if (text[pos] === '[') readIndex();
  else readField();

  while (pos < n) {
    const c = text[pos];
    if (c === '.') {
      pos++;
      readField();
    } else if (c === '[') {
      readIndex();
    } else {
      fail(`unexpected character ${JSON.stringify(c)}`);
    }
  }
  return segments;
}

const PATH_CACHE_LIMIT = 4096;
const pathCache = new Map<string, Path>();

/**
 * Like {@link parsePath}, but memoises results. Intended for paths that come from configuration
 * or compiled programs, which are parsed repeatedly but drawn from a small set.
 */
export function parsePathCached(text: string): Path {
  let path = pathCache.get(text);
  if (path === undefined) {
    path = Object.freeze(parsePath(text));
    if (pathCache.size >= PATH_CACHE_LIMIT) pathCache.clear();
    pathCache.set(text, path);
  }
  return path;
}

/** Formats a path back into its canonical textual form. `formatPath(parsePath(s))` is stable. */
export function formatPath(path: Path): string {
  if (path.length === 0) return '.';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) out += `.${segment}`;
    else out += `.${JSON.stringify(segment)}`;
  }
  return out;
}

function resolveIndex(length: number, index: number): number {
  return index < 0 ? length + index : index;
}

/** Reads the value at `path`, or `undefined` if any step is missing or of the wrong kind. */
export function getPath(root: Value, path: Path): Value | undefined {
  let current: Value | undefined = root;
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (!(current instanceof Map)) return undefined;
      current = current.get(segment);
    } else {
      if (!Array.isArray(current)) return undefined;
      const i = resolveIndex(current.length, segment);
      if (i < 0 || i >= current.length) return undefined;
      current = current[i];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

export function hasPath(root: Value, path: Path): boolean {
  return getPath(root, path) !== undefined;
}

/**
 * Writes `value` at `path` under `root`, creating intermediate objects and arrays as needed.
 * An intermediate of the wrong kind is replaced (setting `.a.b` when `.a` is a string turns `.a`
 * into an object). Writing past the end of an array pads it with `null`.
 *
 * Returns `false` without modifying anything if the path is empty, starts with an index (the
 * root is always an object), or a negative index points before the start of an array.
 */
export function setPath(root: ValueMap, path: Path, value: Value): boolean {
  if (path.length === 0 || typeof path[0] === 'number') return false;
  // Validate negative indices first so a failed write leaves the tree untouched.
  if (!negativeIndicesResolvable(root, path)) return false;

  let container: ValueMap | Value[] = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const nextIsIndex = typeof path[i + 1] === 'number';
    const existing = readChild(container, segment);
    let child: ValueMap | Value[];
    if (nextIsIndex ? Array.isArray(existing) : existing instanceof Map) {
      child = existing as ValueMap | Value[];
    } else {
      child = nextIsIndex ? [] : new Map();
      writeChild(container, segment, child);
    }
    container = child;
  }
  writeChild(container, path[path.length - 1]!, value);
  return true;
}

/**
 * Removes the value at `path` and returns it, or `undefined` if nothing was there. Removing an
 * array element shifts later elements down. The root cannot be removed.
 */
export function deletePath(root: ValueMap, path: Path): Value | undefined {
  if (path.length === 0) return undefined;
  const parent = getPath(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
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

function negativeIndicesResolvable(root: ValueMap, path: Path): boolean {
  let current: Value | undefined = root;
  for (const segment of path) {
    if (typeof segment === 'number' && segment < 0) {
      if (!Array.isArray(current) || resolveIndex(current.length, segment) < 0) return false;
    }
    // Once the walk leaves existing data, every later container is created empty, so any
    // remaining negative index is unresolvable; keep walking with `undefined` to catch it.
    current =
      typeof segment === 'string'
        ? current instanceof Map
          ? current.get(segment)
          : undefined
        : Array.isArray(current)
          ? current[resolveIndex(current.length, segment)]
          : undefined;
  }
  return true;
}

function readChild(container: ValueMap | Value[], segment: PathSegment): Value | undefined {
  if (typeof segment === 'string') {
    return container instanceof Map ? container.get(segment) : undefined;
  }
  if (!Array.isArray(container)) return undefined;
  return container[resolveIndex(container.length, segment)];
}

function writeChild(container: ValueMap | Value[], segment: PathSegment, value: Value): void {
  // setPath guarantees the container kind matches the segment kind: string segments address
  // Maps and index segments address arrays.
  if (container instanceof Map) {
    container.set(segment as string, value);
    return;
  }
  const i = resolveIndex(container.length, segment as number);
  while (container.length < i) container.push(null);
  container[i] = value;
}

/** Returns true if `prefix` is a (non-strict) prefix of `path`. */
export function isPathPrefix(prefix: Path, path: Path): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false;
  }
  return true;
}

/**
 * Visits every leaf (non-container value) under `root` in insertion order, with its path.
 * Empty objects and arrays are reported as leaves so no information is lost.
 */
export function walkLeaves(root: Value, visit: (path: Path, value: Value) => void): void {
  const path: PathSegment[] = [];
  const walk = (value: Value): void => {
    if (value instanceof Map && value.size > 0) {
      for (const [k, v] of value) {
        path.push(k);
        walk(v);
        path.pop();
      }
    } else if (Array.isArray(value) && value.length > 0) {
      for (let i = 0; i < value.length; i++) {
        path.push(i);
        walk(value[i]!);
        path.pop();
      }
    } else {
      visit(path.slice(), value);
    }
  };
  walk(root);
}
