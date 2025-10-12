import { isInt64, Timestamp, wrapInt64, type Value } from '@ferrule/core';

/** Target kinds for `remap_fields`' `coerce` operation. */
export type CoerceTarget = 'int' | 'float' | 'string' | 'bool' | 'timestamp';

/** How a `timestamp` coercion interprets its source value. */
export type TimestampFormat = 'rfc3339' | 'unix_seconds' | 'unix_millis' | 'unix_nanos';

const TRUE_STRINGS = new Set(['true', '1', 'yes', 'on', 't']);
const FALSE_STRINGS = new Set(['false', '0', 'no', 'off', 'f']);

/**
 * Converts `value` to `target`, or returns `undefined` if the conversion isn't meaningful (an
 * empty string coerced to an int, a NaN-producing float parse, an unparsable timestamp). Never
 * throws: the caller (`remap_fields`) decides what to do with a failed coercion.
 */
export function coerceValue(
  value: Value,
  target: CoerceTarget,
  timestampFormat: TimestampFormat = 'rfc3339',
): Value | undefined {
  switch (target) {
    case 'string':
      return coerceToString(value);
    case 'bool':
      return coerceToBool(value);
    case 'int':
      return coerceToInt(value);
    case 'float':
      return coerceToFloat(value);
    case 'timestamp':
      return coerceToTimestamp(value, timestampFormat);
  }
}

function coerceToString(value: Value): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'number':
      return Number.isFinite(value) ? String(value) : undefined;
    default:
      break;
  }
  if (value instanceof Timestamp) return value.toISOString();
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  }
  return undefined; // arrays / objects have no sensible scalar string form
}

function coerceToBool(value: Value): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(lower)) return true;
    if (FALSE_STRINGS.has(lower)) return false;
  }
  return undefined;
}

function coerceToInt(value: Value): bigint | undefined {
  if (typeof value === 'bigint') return isInt64(value) ? value : wrapInt64(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return wrapInt64(BigInt(Math.trunc(value)));
  }
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (/^[+-]?\d+$/.test(trimmed)) {
      try {
        return wrapInt64(BigInt(trimmed));
      } catch {
        return undefined;
      }
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? wrapInt64(BigInt(Math.trunc(n))) : undefined;
  }
  return undefined;
}

function coerceToFloat(value: Value): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceToTimestamp(value: Value, format: TimestampFormat): Timestamp | undefined {
  if (value instanceof Timestamp) return value;
  if (format === 'rfc3339') {
    return typeof value === 'string' ? Timestamp.tryParse(value) : undefined;
  }
  let numeric: number | bigint | undefined;
  if (typeof value === 'bigint' || typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) numeric = n;
  }
  if (numeric === undefined) return undefined;
  try {
    switch (format) {
      case 'unix_seconds':
        return Timestamp.fromSeconds(numeric);
      case 'unix_millis':
        return Timestamp.fromMillis(numeric);
      case 'unix_nanos':
        return Timestamp.fromNanos(
          typeof numeric === 'bigint' ? numeric : BigInt(Math.trunc(numeric)),
        );
    }
  } catch {
    return undefined;
  }
}

/** Best-effort numeric extraction, used where operators consume a field as a number. */
export function toNumber(value: Value | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
