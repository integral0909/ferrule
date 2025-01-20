import { LimitExceededError, ValueTypeError } from './errors.js';
import { Timestamp } from './timestamp.js';

/**
 * A field value inside an event.
 *
 * | kind        | representation        |
 * | ----------- | --------------------- |
 * | `null`      | `null`                |
 * | `boolean`   | `boolean`             |
 * | `integer`   | `bigint` (int64)      |
 * | `float`     | `number` (float64)    |
 * | `string`    | `string`              |
 * | `bytes`     | `Uint8Array`          |
 * | `timestamp` | {@link Timestamp}     |
 * | `array`     | `Value[]`             |
 * | `object`    | `Map<string, Value>`  |
 */
export type Value =
  null | boolean | bigint | number | string | Uint8Array | Timestamp | Value[] | ValueMap;

/** An insertion-ordered object value. `Map` keeps untrusted keys (e.g. `__proto__`) as plain data. */
export type ValueMap = Map<string, Value>;

export type ValueKind =
  'null' | 'boolean' | 'integer' | 'float' | 'string' | 'bytes' | 'timestamp' | 'array' | 'object';

export const INT64_MIN = -(1n << 63n);
export const INT64_MAX = (1n << 63n) - 1n;

export function kindOf(value: Value): ValueKind {
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'integer';
    case 'number':
      return 'float';
    case 'string':
      return 'string';
    case 'object':
      if (value === null) return 'null';
      if (value instanceof Map) return 'object';
      if (Array.isArray(value)) return 'array';
      if (value instanceof Timestamp) return 'timestamp';
      return 'bytes';
    default:
      throw new ValueTypeError(`not a Ferrule value: ${typeof value}`);
  }
}

export function isValueMap(value: Value | undefined): value is ValueMap {
  return value instanceof Map;
}

export function isValueArray(value: Value | undefined): value is Value[] {
  return Array.isArray(value);
}

export function isInt64(n: bigint): boolean {
  return n >= INT64_MIN && n <= INT64_MAX;
}

/** Wraps an arbitrary bigint into the int64 range (two's complement), like int64 overflow. */
export function wrapInt64(n: bigint): bigint {
  return BigInt.asIntN(64, n);
}

/** Returns true if `value` is truthy in the Ferrule sense: only `true` is true. */
export function isTrue(value: Value | undefined): boolean {
  return value === true;
}

/**
 * Structural equality. Integers and floats are never equal to each other (`1` ≠ `1.0`), `NaN`
 * equals `NaN`, and `0.0` equals `-0.0`. Object key order does not affect equality.
 */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === 'number') return typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, av] of a) {
      const bv = b.get(k);
      if (bv === undefined || !valuesEqual(av, bv)) return false;
    }
    return true;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i]!, b[i]!)) return false;
    }
    return true;
  }
  if (a instanceof Timestamp) return b instanceof Timestamp && a.nanos === b.nanos;
  if (b instanceof Map || Array.isArray(b) || b instanceof Timestamp) return false;
  return bytesEqual(a, b);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const KIND_RANK: Record<ValueKind, number> = {
  null: 0,
  boolean: 1,
  integer: 2,
  float: 2,
  string: 3,
  bytes: 4,
  timestamp: 5,
  array: 6,
  object: 7,
};

/**
 * A total order over values, suitable for sorting and for deterministic output.
 *
 * Kinds order as null < boolean < number < string < bytes < timestamp < array < object.
 * Integers and floats compare numerically with each other; when numerically equal the integer
 * sorts first. `NaN` sorts after every other number. Strings compare by UTF-16 code unit.
 * Arrays compare lexicographically; objects compare by their sorted entries.
 */
export function compareValues(a: Value, b: Value): -1 | 0 | 1 {
  const ka = kindOf(a);
  const kb = kindOf(b);
  const ra = KIND_RANK[ka];
  const rb = KIND_RANK[kb];
  if (ra !== rb) return ra < rb ? -1 : 1;

  switch (ka) {
    case 'null':
      return 0;
    case 'boolean':
      return a === b ? 0 : a === false ? -1 : 1;
    case 'integer':
    case 'float':
      return compareNumbers(a as bigint | number, b as bigint | number);
    case 'string':
      return a === b ? 0 : (a as string) < (b as string) ? -1 : 1;
    case 'bytes':
      return compareBytes(a as Uint8Array, b as Uint8Array);
    case 'timestamp':
      return (a as Timestamp).compare(b as Timestamp);
    case 'array': {
      const aa = a as Value[];
      const ba = b as Value[];
      const n = Math.min(aa.length, ba.length);
      for (let i = 0; i < n; i++) {
        const c = compareValues(aa[i]!, ba[i]!);
        if (c !== 0) return c;
      }
      return sign(aa.length - ba.length);
    }
    case 'object': {
      const ae = [...(a as ValueMap)].sort(compareEntryKeys);
      const be = [...(b as ValueMap)].sort(compareEntryKeys);
      const n = Math.min(ae.length, be.length);
      for (let i = 0; i < n; i++) {
        const [ak, av] = ae[i]!;
        const [bk, bv] = be[i]!;
        if (ak !== bk) return ak < bk ? -1 : 1;
        const c = compareValues(av, bv);
        if (c !== 0) return c;
      }
      return sign(ae.length - be.length);
    }
  }
}

function compareNumbers(a: bigint | number, b: bigint | number): -1 | 0 | 1 {
  const aNaN = typeof a === 'number' && Number.isNaN(a);
  const bNaN = typeof b === 'number' && Number.isNaN(b);
  if (aNaN || bNaN) return aNaN && bNaN ? 0 : aNaN ? 1 : -1;
  // Mixed bigint/number relational comparison is exact in JavaScript.
  if (a < b) return -1;
  if (a > b) return 1;
  if (typeof a === typeof b) return 0;
  return typeof a === 'bigint' ? -1 : 1;
}

function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return sign(a.byteLength - b.byteLength);
}

function compareEntryKeys(a: [string, Value], b: [string, Value]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/** Deep copy. Timestamps are immutable and shared; bytes, arrays, and objects are copied. */
export function cloneValue<V extends Value>(value: V): V {
  return cloneAny(value) as V;
}

function cloneAny(value: Value): Value {
  if (typeof value !== 'object' || value === null || value instanceof Timestamp) return value;
  if (value instanceof Map) {
    const out: ValueMap = new Map();
    for (const [k, v] of value) out.set(k, cloneAny(v));
    return out;
  }
  if (Array.isArray(value)) return value.map(cloneAny);
  return value.slice();
}

/**
 * Approximate in-memory size in bytes. Used for buffer and channel accounting, where a cheap,
 * monotonic estimate matters more than precision.
 */
export function estimateSize(value: Value): number {
  switch (typeof value) {
    case 'boolean':
      return 1;
    case 'bigint':
    case 'number':
      return 8;
    case 'string':
      return 8 + value.length;
    case 'object': {
      if (value === null) return 1;
      if (value instanceof Map) {
        let size = 16;
        for (const [k, v] of value) size += 8 + k.length + estimateSize(v);
        return size;
      }
      if (Array.isArray(value)) {
        let size = 16;
        for (const v of value) size += estimateSize(v);
        return size;
      }
      if (value instanceof Timestamp) return 16;
      return 8 + value.byteLength;
    }
    default:
      return 0;
  }
}

export interface FromPlainOptions {
  /**
   * How to convert JavaScript numbers. `auto` (default) turns safe integers into integer values
   * and everything else into floats; `float` keeps every number a float.
   */
  numbers?: 'auto' | 'float';
  /** Maximum nesting depth; guards against cyclic or hostile input. Default 128. */
  maxDepth?: number;
}

/**
 * Converts an arbitrary JavaScript value (for example the output of `JSON.parse` or data handed
 * over by a plugin) into a {@link Value}. Plain objects become `Map`s, `Date`s become timestamps,
 * `undefined` object properties are skipped. Functions and symbols are rejected.
 */
export function fromPlain(input: unknown, options: FromPlainOptions = {}): Value {
  const numbers = options.numbers ?? 'auto';
  const maxDepth = options.maxDepth ?? 128;

  const convert = (x: unknown, depth: number): Value => {
    if (depth > maxDepth) throw new LimitExceededError('depth', maxDepth);
    switch (typeof x) {
      case 'undefined':
        return null;
      case 'boolean':
      case 'string':
        return x;
      case 'number':
        return numbers === 'auto' && Number.isSafeInteger(x) && !Object.is(x, -0) ? BigInt(x) : x;
      case 'bigint':
        if (!isInt64(x)) throw new ValueTypeError(`integer ${x} is outside the int64 range`);
        return x;
      case 'object': {
        if (x === null) return null;
        if (x instanceof Timestamp) return x;
        if (x instanceof Date) return Timestamp.fromDate(x);
        if (x instanceof Uint8Array) return new Uint8Array(x);
        if (x instanceof ArrayBuffer) return new Uint8Array(x.slice(0));
        if (ArrayBuffer.isView(x)) {
          throw new ValueTypeError(`unsupported typed array: ${x.constructor.name}`);
        }
        if (Array.isArray(x)) return x.map((item: unknown) => convert(item, depth + 1));
        const out: ValueMap = new Map();
        if (x instanceof Map) {
          for (const [k, v] of x as Map<unknown, unknown>) {
            if (typeof k !== 'string') throw new ValueTypeError('object keys must be strings');
            if (v !== undefined) out.set(k, convert(v, depth + 1));
          }
          return out;
        }
        for (const k of Object.keys(x)) {
          const v = (x as Record<string, unknown>)[k];
          if (v !== undefined) out.set(k, convert(v, depth + 1));
        }
        return out;
      }
      default:
        throw new ValueTypeError(`cannot convert a ${typeof x} to a Ferrule value`);
    }
  };
  return convert(input, 0);
}

export interface ToPlainOptions {
  /** How to represent integers: as `bigint` (default), `number` (may lose precision), or `string`. */
  integers?: 'bigint' | 'number' | 'string';
  /** How to represent bytes: as `Uint8Array` (default) or a base64 string. */
  bytes?: 'uint8array' | 'base64';
  /** How to represent timestamps: as {@link Timestamp} (default), an RFC 3339 string, or a `Date`. */
  timestamps?: 'timestamp' | 'string' | 'date';
}

/**
 * Converts a {@link Value} into plain JavaScript data: objects become ordinary objects (keys are
 * defined with `Object.defineProperty`, so a `__proto__` key stays an own property).
 */
export function toPlain(value: Value, options: ToPlainOptions = {}): unknown {
  const integers = options.integers ?? 'bigint';
  const bytes = options.bytes ?? 'uint8array';
  const timestamps = options.timestamps ?? 'timestamp';

  const convert = (v: Value): unknown => {
    switch (typeof v) {
      case 'bigint':
        return integers === 'bigint' ? v : integers === 'number' ? Number(v) : v.toString();
      case 'object': {
        if (v === null) return null;
        if (v instanceof Map) {
          const out: Record<string, unknown> = {};
          for (const [k, item] of v) {
            Object.defineProperty(out, k, {
              value: convert(item),
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          return out;
        }
        if (Array.isArray(v)) return v.map(convert);
        if (v instanceof Timestamp) {
          return timestamps === 'timestamp'
            ? v
            : timestamps === 'string'
              ? v.toISOString()
              : v.toDate();
        }
        return bytes === 'uint8array'
          ? v
          : Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
      }
      default:
        return v;
    }
  };
  return convert(value);
}

/** Shorthand for building an object value from a plain record, converting nested values. */
export function objectOf(record: Record<string, unknown>): ValueMap {
  return fromPlain(record) as ValueMap;
}

/**
 * Renders a value in Ferrule Script literal syntax, for diagnostics, the REPL, and `tap`.
 * Floats always include a decimal point or exponent so they read back as floats.
 */
export function formatValue(value: Value, maxLength = Infinity): string {
  const text = formatInner(value);
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function formatInner(value: Value): string {
  switch (typeof value) {
    case 'boolean':
      return String(value);
    case 'bigint':
      return value.toString();
    case 'number':
      return formatFloat(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      if (value instanceof Map) {
        if (value.size === 0) return '{}';
        const parts: string[] = [];
        for (const [k, v] of value) parts.push(`${JSON.stringify(k)}: ${formatInner(v)}`);
        return `{ ${parts.join(', ')} }`;
      }
      if (Array.isArray(value)) return `[${value.map(formatInner).join(', ')}]`;
      if (value instanceof Timestamp) return `t'${value.toISOString()}'`;
      return `b"${formatBytes(value)}"`;
    }
    default:
      return String(value);
  }
}

/** Formats a float so it is recognisably a float: `1.0`, `1.5e+30`, `NaN`, `Infinity`. */
export function formatFloat(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  if (s.includes('.') || s.includes('e')) return s;
  return Object.is(n, -0) ? '-0.0' : `${s}.0`;
}

function formatBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}
