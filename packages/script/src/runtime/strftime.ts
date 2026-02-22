import { Timestamp } from '@ferrule/core';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * A strftime-style subset for `format_timestamp` (design.md's numbers/time category): `%Y %y %m
 * %d %e %H %I %M %S %L %f %p %a %A %b %B %j %z %Z %%`. Always renders in UTC (the value model has
 * no time zone concept beyond UTC offset 0 — see `@ferrule/core`'s `Timestamp`).
 */
export function formatStrftime(ts: Timestamp, pattern: string): string {
  const c = ts.toCivil();
  const millis = Math.floor(c.nanosecond / 1_000_000);
  const micros = Math.floor(c.nanosecond / 1_000);
  const weekday = weekdayOf(ts);
  const hour12 = c.hour % 12 === 0 ? 12 : c.hour % 12;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '%' || i === pattern.length - 1) {
      out += pattern[i];
      continue;
    }
    const d = pattern[++i];
    switch (d) {
      case 'Y':
        out += pad(c.year, 4);
        break;
      case 'y':
        out += pad(c.year % 100, 2);
        break;
      case 'm':
        out += pad(c.month, 2);
        break;
      case 'd':
        out += pad(c.day, 2);
        break;
      case 'e':
        out += String(c.day).padStart(2, ' ');
        break;
      case 'H':
        out += pad(c.hour, 2);
        break;
      case 'I':
        out += pad(hour12, 2);
        break;
      case 'M':
        out += pad(c.minute, 2);
        break;
      case 'S':
        out += pad(c.second, 2);
        break;
      case 'L':
        out += pad(millis, 3);
        break;
      case 'f':
        out += pad(micros, 6);
        break;
      case 'p':
        out += c.hour < 12 ? 'AM' : 'PM';
        break;
      case 'a':
        out += WEEKDAY_NAMES[weekday]!.slice(0, 3);
        break;
      case 'A':
        out += WEEKDAY_NAMES[weekday]!;
        break;
      case 'b':
        out += MONTH_NAMES[c.month - 1]!.slice(0, 3);
        break;
      case 'B':
        out += MONTH_NAMES[c.month - 1]!;
        break;
      case 'j':
        out += pad(dayOfYear(c.year, c.month, c.day), 3);
        break;
      case 'z':
        out += '+0000';
        break;
      case 'Z':
        out += 'UTC';
        break;
      case '%':
        out += '%';
        break;
      default:
        out += `%${d ?? ''}`;
    }
  }
  return out;
}

function weekdayOf(ts: Timestamp): number {
  const days = Math.floor(ts.toMillis() / 86_400_000);
  // 1970-01-01 was a Thursday (4).
  return ((days % 7) + 7 + 4) % 7;
}

function dayOfYear(year: number, month: number, day: number): number {
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return cumulative[month - 1]! + day + (leap && month > 2 ? 1 : 0);
}

interface FieldWidths {
  Y: number;
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
  S: number;
  L: number;
  f: number;
}
const WIDTHS: FieldWidths = { Y: 4, y: 2, m: 2, d: 2, H: 2, M: 2, S: 2, L: 3, f: 6 };

/**
 * Parses `text` against a {@link formatStrftime} pattern using the numeric directives (`%Y %y %m
 * %d %H %M %S %L %f %z`); non-numeric directives (`%a`, `%B`, ...) are not supported for parsing.
 * Returns `undefined` if `text` does not match. Fields not present in the pattern default to the
 * start of their unit (year 1970, month/day 1, time 00:00:00).
 */
export function parseStrftime(text: string, pattern: string): Timestamp | undefined {
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let nanosecond = 0;
  let offsetMinutes = 0;
  let ti = 0;

  const readInt = (width: number): number | undefined => {
    const slice = text.slice(ti, ti + width);
    if (!/^\d+$/.test(slice)) return undefined;
    ti += width;
    return Number(slice);
  };

  for (let pi = 0; pi < pattern.length; pi++) {
    if (pattern[pi] !== '%' || pi === pattern.length - 1) {
      if (text[ti] !== pattern[pi]) return undefined;
      ti++;
      continue;
    }
    const d = pattern[++pi];
    switch (d) {
      case 'Y': {
        const v = readInt(WIDTHS.Y);
        if (v === undefined) return undefined;
        year = v;
        break;
      }
      case 'y': {
        const v = readInt(WIDTHS.y);
        if (v === undefined) return undefined;
        year = v < 69 ? 2000 + v : 1900 + v;
        break;
      }
      case 'm': {
        const v = readInt(WIDTHS.m);
        if (v === undefined) return undefined;
        month = v;
        break;
      }
      case 'd': {
        const v = readInt(WIDTHS.d);
        if (v === undefined) return undefined;
        day = v;
        break;
      }
      case 'H': {
        const v = readInt(WIDTHS.H);
        if (v === undefined) return undefined;
        hour = v;
        break;
      }
      case 'M': {
        const v = readInt(WIDTHS.M);
        if (v === undefined) return undefined;
        minute = v;
        break;
      }
      case 'S': {
        const v = readInt(WIDTHS.S);
        if (v === undefined) return undefined;
        second = v;
        break;
      }
      case 'L': {
        const v = readInt(WIDTHS.L);
        if (v === undefined) return undefined;
        nanosecond = v * 1_000_000;
        break;
      }
      case 'f': {
        const v = readInt(WIDTHS.f);
        if (v === undefined) return undefined;
        nanosecond = v * 1_000;
        break;
      }
      case 'z': {
        const m = /^([+-]\d{2}):?(\d{2})/.exec(text.slice(ti));
        if (m === null) return undefined;
        const sign = m[1]!.startsWith('-') ? -1 : 1;
        offsetMinutes = sign * (Number(m[1]!.slice(1)) * 60 + Number(m[2]!));
        ti += m[0].length;
        break;
      }
      case '%':
        if (text[ti] !== '%') return undefined;
        ti++;
        break;
      default:
        return undefined;
    }
  }
  if (ti !== text.length) return undefined;
  try {
    const local = Timestamp.fromCivil({ year, month, day, hour, minute, second, nanosecond });
    return local.add(BigInt(-offsetMinutes) * 60_000_000_000n);
  } catch {
    return undefined;
  }
}
