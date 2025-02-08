import { ParseError, ValueTypeError } from './errors.js';

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_MILLI = 1_000_000n;
const SECONDS_PER_DAY = 86_400;

/** Output precision for {@link Timestamp.toISOString}. `auto` uses the shortest of s/ms/µs/ns that is exact. */
export type TimestampPrecision = 'auto' | 's' | 'ms' | 'us' | 'ns';

/**
 * An instant in time with nanosecond precision, stored as signed nanoseconds since the Unix
 * epoch. Immutable. Telemetry protocols (OTLP, many log formats) carry nanosecond timestamps,
 * which JavaScript `Date` cannot represent.
 */
export class Timestamp {
  readonly nanos: bigint;

  private constructor(nanos: bigint) {
    this.nanos = nanos;
  }

  static fromNanos(nanos: bigint): Timestamp {
    return new Timestamp(nanos);
  }

  static fromMicros(micros: bigint | number): Timestamp {
    return new Timestamp(toBigIntExact(micros, 'microseconds') * 1_000n);
  }

  static fromMillis(millis: number | bigint): Timestamp {
    if (typeof millis === 'bigint') return new Timestamp(millis * NANOS_PER_MILLI);
    if (!Number.isFinite(millis)) {
      throw new ValueTypeError(`cannot create a timestamp from ${millis} milliseconds`);
    }
    // Keep sub-millisecond precision from fractional input, rounded to the nearest nanosecond.
    const whole = Math.floor(millis);
    const frac = Math.round((millis - whole) * 1e6);
    return new Timestamp(BigInt(whole) * NANOS_PER_MILLI + BigInt(frac));
  }

  /** Accepts fractional seconds (e.g. `1700000000.123456`); precision is limited by float64. */
  static fromSeconds(seconds: number | bigint): Timestamp {
    if (typeof seconds === 'bigint') return new Timestamp(seconds * NANOS_PER_SECOND);
    if (!Number.isFinite(seconds)) {
      throw new ValueTypeError(`cannot create a timestamp from ${seconds} seconds`);
    }
    const whole = Math.floor(seconds);
    const frac = Math.round((seconds - whole) * 1e9);
    return new Timestamp(BigInt(whole) * NANOS_PER_SECOND + BigInt(frac));
  }

  static fromDate(date: Date): Timestamp {
    const ms = date.getTime();
    if (Number.isNaN(ms)) {
      throw new ValueTypeError('cannot create a timestamp from an invalid Date');
    }
    return new Timestamp(BigInt(ms) * NANOS_PER_MILLI);
  }

  static now(): Timestamp {
    return new Timestamp(BigInt(Date.now()) * NANOS_PER_MILLI);
  }

  /**
   * Builds a timestamp from UTC calendar fields. Months are 1-based. Fields are validated;
   * a leap second (`second === 60`) is accepted and clamped to the last nanosecond of the
   * preceding second, since the value model has no representation for it.
   */
  static fromCivil(fields: CivilFields): Timestamp {
    const { year, month, day, hour = 0, minute = 0, second = 0, nanosecond = 0 } = fields;
    validateCivil(year, month, day, hour, minute, second, nanosecond);
    let sec = second;
    let ns = nanosecond;
    if (sec === 60) {
      sec = 59;
      ns = 999_999_999;
    }
    const days = daysFromCivil(year, month, day);
    const totalSeconds =
      BigInt(days) * BigInt(SECONDS_PER_DAY) + BigInt(hour * 3600 + minute * 60 + sec);
    return new Timestamp(totalSeconds * NANOS_PER_SECOND + BigInt(ns));
  }

  /**
   * Parses an RFC 3339 timestamp such as `2026-03-01T12:30:00.123456789+02:00`.
   * Accepts `t`/`T`/space as the date-time separator and `z`/`Z` for UTC. Fractional seconds
   * beyond nanosecond precision are truncated.
   */
  static parse(text: string): Timestamp {
    const result = Timestamp.tryParse(text);
    if (result === undefined) {
      throw new ParseError(
        'E_TIMESTAMP_SYNTAX',
        `invalid RFC 3339 timestamp: ${JSON.stringify(truncate(text))}`,
      );
    }
    return result;
  }

  /** Like {@link parse} but returns `undefined` instead of throwing. */
  static tryParse(text: string): Timestamp | undefined {
    const m = RFC3339.exec(text);
    if (m === null) return undefined;
    const [, y, mo, d, h, mi, s, frac, zone] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | undefined,
      string,
    ];
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);
    const nanosecond = frac === undefined ? 0 : Number(frac.slice(0, 9).padEnd(9, '0'));
    if (!isValidCivil(year, month, day, hour, minute, second, nanosecond)) return undefined;

    let offsetMinutes = 0;
    if (zone !== 'Z' && zone !== 'z') {
      const sign = zone.startsWith('-') ? -1 : 1;
      const oh = Number(zone.slice(1, 3));
      const om = Number(zone.slice(4, 6));
      if (oh > 23 || om > 59) return undefined;
      offsetMinutes = sign * (oh * 60 + om);
    }
    const local = Timestamp.fromCivil({ year, month, day, hour, minute, second, nanosecond });
    return new Timestamp(local.nanos - BigInt(offsetMinutes) * 60n * NANOS_PER_SECOND);
  }

  /** Whole seconds since the epoch (floored) and the nanosecond remainder in [0, 1e9). */
  toSecondsAndNanos(): { seconds: bigint; nanos: number } {
    const seconds = floorDiv(this.nanos, NANOS_PER_SECOND);
    return { seconds, nanos: Number(this.nanos - seconds * NANOS_PER_SECOND) };
  }

  /** Milliseconds since the epoch, floored. Loses sub-millisecond precision. */
  toMillis(): number {
    return Number(floorDiv(this.nanos, NANOS_PER_MILLI));
  }

  /** Seconds since the epoch as a float. Loses precision beyond ~microseconds for current dates. */
  toSeconds(): number {
    const { seconds, nanos } = this.toSecondsAndNanos();
    return Number(seconds) + nanos / 1e9;
  }

  toDate(): Date {
    return new Date(this.toMillis());
  }

  toCivil(): Required<CivilFields> {
    const { seconds, nanos } = this.toSecondsAndNanos();
    const days = Number(floorDiv(seconds, BigInt(SECONDS_PER_DAY)));
    const secOfDay = Number(seconds - BigInt(days) * BigInt(SECONDS_PER_DAY));
    const [year, month, day] = civilFromDays(days);
    return {
      year,
      month,
      day,
      hour: Math.floor(secOfDay / 3600),
      minute: Math.floor((secOfDay % 3600) / 60),
      second: secOfDay % 60,
      nanosecond: nanos,
    };
  }

  /** Formats as RFC 3339 in UTC, e.g. `2026-03-01T10:30:00.123Z`. */
  toISOString(precision: TimestampPrecision = 'auto'): string {
    const c = this.toCivil();
    const date = `${formatYear(c.year)}-${pad2(c.month)}-${pad2(c.day)}`;
    const time = `${pad2(c.hour)}:${pad2(c.minute)}:${pad2(c.second)}`;
    return `${date}T${time}${formatFraction(c.nanosecond, precision)}Z`;
  }

  toString(): string {
    return this.toISOString();
  }

  toJSON(): string {
    return this.toISOString();
  }

  add(nanos: bigint): Timestamp {
    return new Timestamp(this.nanos + nanos);
  }

  /** Nanoseconds from `other` to `this` (positive if `this` is later). */
  since(other: Timestamp): bigint {
    return this.nanos - other.nanos;
  }

  /** Rounds down to a multiple of `unitNanos` (e.g. to the start of a minute window). */
  truncate(unitNanos: bigint): Timestamp {
    if (unitNanos <= 0n) throw new RangeError('truncation unit must be positive');
    return new Timestamp(floorDiv(this.nanos, unitNanos) * unitNanos);
  }

  compare(other: Timestamp): -1 | 0 | 1 {
    return this.nanos < other.nanos ? -1 : this.nanos > other.nanos ? 1 : 0;
  }

  equals(other: Timestamp): boolean {
    return this.nanos === other.nanos;
  }

  isBefore(other: Timestamp): boolean {
    return this.nanos < other.nanos;
  }

  isAfter(other: Timestamp): boolean {
    return this.nanos > other.nanos;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Timestamp(${this.toISOString('ns')})`;
  }
}

export interface CivilFields {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  hour?: number;
  minute?: number;
  /** 0–60 (60 for a leap second) */
  second?: number;
  nanosecond?: number;
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isValidCivil(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  nanosecond: number,
): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59 &&
    Number.isInteger(second) &&
    second >= 0 &&
    second <= 60 &&
    Number.isInteger(nanosecond) &&
    nanosecond >= 0 &&
    nanosecond <= 999_999_999
  );
}

function validateCivil(...args: Parameters<typeof isValidCivil>): void {
  if (!isValidCivil(...args)) {
    const [y, mo, d, h, mi, s, ns] = args;
    throw new ValueTypeError(`invalid calendar date/time: ${y}-${mo}-${d} ${h}:${mi}:${s}.${ns}`);
  }
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date. Uses the era-based algorithm, which is
 * exact for all years representable as safe integers and needs no `Date` object.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Inverse of {@link daysFromCivil}: returns `[year, month, day]`. */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** Floor division for bigints (JavaScript's `/` truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function formatFraction(nanos: number, precision: TimestampPrecision): string {
  const digits = String(nanos).padStart(9, '0');
  switch (precision) {
    case 's':
      return '';
    case 'ms':
      return `.${digits.slice(0, 3)}`;
    case 'us':
      return `.${digits.slice(0, 6)}`;
    case 'ns':
      return `.${digits}`;
    case 'auto':
      if (nanos === 0) return '';
      if (nanos % 1_000_000 === 0) return `.${digits.slice(0, 3)}`;
      if (nanos % 1_000 === 0) return `.${digits.slice(0, 6)}`;
      return `.${digits}`;
  }
}

function formatYear(year: number): string {
  if (year >= 0 && year <= 9999) return String(year).padStart(4, '0');
  // ISO 8601 expanded representation for years outside 0000–9999.
  return (year < 0 ? '-' : '+') + String(Math.abs(year)).padStart(6, '0');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toBigIntExact(n: number | bigint, unit: string): bigint {
  if (typeof n === 'bigint') return n;
  if (!Number.isSafeInteger(n)) {
    throw new ValueTypeError(`${unit} must be a safe integer, got ${n}`);
  }
  return BigInt(n);
}

function truncate(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
