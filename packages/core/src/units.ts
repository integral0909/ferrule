import { ParseError } from './errors.js';

const DURATION_UNITS: ReadonlyMap<string, bigint> = new Map([
  ['ns', 1n],
  ['us', 1_000n],
  ['µs', 1_000n],
  ['ms', 1_000_000n],
  ['s', 1_000_000_000n],
  ['m', 60_000_000_000n],
  ['h', 3_600_000_000_000n],
  ['d', 86_400_000_000_000n],
  ['w', 604_800_000_000_000n],
]);

const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|m|h|d|w)/y;

/**
 * Parses a human-friendly duration into nanoseconds. Accepts one or more `<number><unit>`
 * components, optionally separated by whitespace: `250ms`, `1h30m`, `1.5s`, `2d 4h`.
 * A bare `0` is accepted. Negative durations are rejected.
 */
export function parseDuration(text: string): bigint {
  const input = text.trim();
  if (input === '0') return 0n;
  if (input === '') throw new ParseError('E_DURATION_SYNTAX', 'duration is empty');

  let total = 0n;
  let pos = 0;
  let lastUnitNanos: bigint | undefined;
  while (pos < input.length) {
    while (input[pos] === ' ') pos++;
    DURATION_TOKEN.lastIndex = pos;
    const m = DURATION_TOKEN.exec(input);
    if (m === null) {
      throw new ParseError(
        'E_DURATION_SYNTAX',
        `invalid duration ${JSON.stringify(text)}: expected <number><unit> with unit one of ns, us, ms, s, m, h, d, w`,
        pos,
      );
    }
    const [, amount, unit] = m as unknown as [string, string, string];
    const unitNanos = DURATION_UNITS.get(unit)!;
    if (lastUnitNanos !== undefined && unitNanos >= lastUnitNanos) {
      throw new ParseError(
        'E_DURATION_SYNTAX',
        `invalid duration ${JSON.stringify(text)}: units must be in decreasing order`,
        pos,
      );
    }
    lastUnitNanos = unitNanos;
    total += scaleDecimal(amount, unitNanos);
    pos = DURATION_TOKEN.lastIndex;
  }
  return total;
}

/** Parses a duration and returns whole milliseconds (rounded down). */
export function parseDurationMillis(text: string): number {
  return Number(parseDuration(text) / 1_000_000n);
}

/**
 * Formats nanoseconds as a compact duration string that {@link parseDuration} accepts,
 * e.g. `1h30m`, `250ms`, `1s500ms`. Zero formats as `0s`.
 */
export function formatDuration(nanos: bigint): string {
  if (nanos === 0n) return '0s';
  let rest = nanos < 0n ? -nanos : nanos;
  const parts: string[] = [];
  for (const [unit, size] of [
    ['d', 86_400_000_000_000n],
    ['h', 3_600_000_000_000n],
    ['m', 60_000_000_000n],
    ['s', 1_000_000_000n],
    ['ms', 1_000_000n],
    ['us', 1_000n],
    ['ns', 1n],
  ] as const) {
    if (rest >= size) {
      parts.push(`${rest / size}${unit}`);
      rest %= size;
    }
  }
  return (nanos < 0n ? '-' : '') + parts.join('');
}

const BYTE_UNITS: ReadonlyMap<string, bigint> = new Map([
  ['', 1n],
  ['b', 1n],
  ['kb', 1_000n],
  ['mb', 1_000_000n],
  ['gb', 1_000_000_000n],
  ['tb', 1_000_000_000_000n],
  ['kib', 1n << 10n],
  ['mib', 1n << 20n],
  ['gib', 1n << 30n],
  ['tib', 1n << 40n],
  // Single-letter forms are binary, matching common configuration conventions (`512k`, `2g`).
  ['k', 1n << 10n],
  ['m', 1n << 20n],
  ['g', 1n << 30n],
  ['t', 1n << 40n],
]);

const BYTE_SIZE = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i;

/**
 * Parses a byte size such as `64MiB`, `1.5GB`, `512k`, or `4096`. Decimal units (KB, MB, ...)
 * are powers of 1000; binary units (KiB, MiB, ... and the single letters k, m, g, t) are powers
 * of 1024. The result must be a safe integer.
 */
export function parseByteSize(text: string): number {
  const m = BYTE_SIZE.exec(text.trim());
  if (m === null) {
    throw new ParseError('E_BYTESIZE_SYNTAX', `invalid byte size ${JSON.stringify(text)}`);
  }
  const [, amount, rawUnit] = m as unknown as [string, string, string];
  const multiplier = BYTE_UNITS.get(rawUnit.toLowerCase());
  if (multiplier === undefined) {
    throw new ParseError(
      'E_BYTESIZE_SYNTAX',
      `invalid byte size ${JSON.stringify(text)}: unknown unit ${JSON.stringify(rawUnit)}`,
    );
  }
  const bytes = scaleDecimal(amount, multiplier);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ParseError('E_BYTESIZE_RANGE', `byte size ${JSON.stringify(text)} is too large`);
  }
  return Number(bytes);
}

/** Formats a byte count using binary units, e.g. `1.5MiB`, `512B`. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`invalid byte count: ${bytes}`);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = i === 0 ? String(value) : String(Math.round(value * 100) / 100);
  return `${rounded}${units[i]}`;
}

/**
 * Multiplies a non-negative decimal string by an integer scale exactly, truncating any
 * remainder below 1. Avoids float rounding: `1.1` * 1e9 is exactly 1_100_000_000.
 */
function scaleDecimal(amount: string, scale: bigint): bigint {
  const dot = amount.indexOf('.');
  if (dot === -1) return BigInt(amount) * scale;
  const intPart = amount.slice(0, dot);
  const fracPart = amount.slice(dot + 1);
  const denominator = 10n ** BigInt(fracPart.length);
  return BigInt(intPart || '0') * scale + (BigInt(fracPart) * scale) / denominator;
}
