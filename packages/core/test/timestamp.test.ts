import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  floorDiv,
  isLeapYear,
  ParseError,
  Timestamp,
  ValueTypeError,
} from '@ferrule/core';

describe('civil date conversion', () => {
  it('maps the epoch to day 0', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(0)).toEqual([1970, 1, 1]);
  });

  it('handles dates before the epoch and leap days', () => {
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    expect(daysFromCivil(2000, 3, 1) - daysFromCivil(2000, 2, 28)).toBe(2);
    expect(daysFromCivil(1900, 3, 1) - daysFromCivil(1900, 2, 28)).toBe(1);
    expect(civilFromDays(daysFromCivil(2024, 2, 29))).toEqual([2024, 2, 29]);
  });

  it('agrees with Date.UTC across a wide range', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2_000_000, max: 2_000_000 }), (days) => {
        const [y, m, d] = civilFromDays(days);
        expect(daysFromCivil(y, m, d)).toBe(days);
        const date = new Date(days * 86_400_000);
        expect([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]).toEqual([
          y,
          m,
          d,
        ]);
      }),
    );
  });

  it('knows leap years and month lengths', () => {
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2023, 4)).toBe(30);
    expect(daysInMonth(2023, 12)).toBe(31);
  });
});

describe('floorDiv', () => {
  it('rounds toward negative infinity', () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, -2n)).toBe(-4n);
    expect(floorDiv(-7n, -2n)).toBe(3n);
    expect(floorDiv(-6n, 2n)).toBe(-3n);
  });
});

describe('Timestamp.parse', () => {
  it('parses UTC timestamps with and without fractions', () => {
    expect(Timestamp.parse('1970-01-01T00:00:00Z').nanos).toBe(0n);
    expect(Timestamp.parse('1970-01-01T00:00:01.5Z').nanos).toBe(1_500_000_000n);
    expect(Timestamp.parse('2026-03-01T12:30:00.123456789Z').toISOString('ns')).toBe(
      '2026-03-01T12:30:00.123456789Z',
    );
  });

  it('applies offsets', () => {
    const a = Timestamp.parse('2026-03-01T12:00:00+02:00');
    const b = Timestamp.parse('2026-03-01T10:00:00Z');
    expect(a.equals(b)).toBe(true);
    expect(Timestamp.parse('2026-03-01T00:30:00-01:30').toISOString()).toBe('2026-03-01T02:00:00Z');
  });

  it('accepts lower-case separators, a space, and a comma decimal', () => {
    expect(Timestamp.parse('2026-01-02t03:04:05z').toISOString()).toBe('2026-01-02T03:04:05Z');
    expect(Timestamp.parse('2026-01-02 03:04:05Z').toISOString()).toBe('2026-01-02T03:04:05Z');
    expect(Timestamp.parse('2026-01-02T03:04:05,25Z').toISOString()).toBe(
      '2026-01-02T03:04:05.250Z',
    );
  });

  it('truncates precision beyond nanoseconds', () => {
    expect(Timestamp.parse('2026-01-01T00:00:00.1234567891234Z').nanos % 1_000_000_000n).toBe(
      123_456_789n,
    );
  });

  it('clamps a leap second to the end of the preceding second', () => {
    const ts = Timestamp.parse('2016-12-31T23:59:60Z');
    expect(ts.toISOString('ns')).toBe('2016-12-31T23:59:59.999999999Z');
  });

  it.each([
    '',
    '2026-01-01',
    '2026-01-01T00:00:00',
    '2026-13-01T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2023-02-29T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:61Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00.Z',
    ' 2026-01-01T00:00:00Z',
  ])('rejects %j', (text) => {
    expect(Timestamp.tryParse(text)).toBeUndefined();
    expect(() => Timestamp.parse(text)).toThrow(ParseError);
  });
});

describe('Timestamp formatting', () => {
  const ts = Timestamp.fromNanos(1_700_000_000_123_456_000n);

  it('chooses the shortest exact precision in auto mode', () => {
    expect(Timestamp.fromMillis(0).toISOString()).toBe('1970-01-01T00:00:00Z');
    expect(Timestamp.fromMillis(1).toISOString()).toBe('1970-01-01T00:00:00.001Z');
    expect(ts.toISOString()).toBe('2023-11-14T22:13:20.123456Z');
    expect(Timestamp.fromNanos(1n).toISOString()).toBe('1970-01-01T00:00:00.000000001Z');
  });

  it('honours explicit precision', () => {
    expect(ts.toISOString('s')).toBe('2023-11-14T22:13:20Z');
    expect(ts.toISOString('ms')).toBe('2023-11-14T22:13:20.123Z');
    expect(ts.toISOString('us')).toBe('2023-11-14T22:13:20.123456Z');
    expect(ts.toISOString('ns')).toBe('2023-11-14T22:13:20.123456000Z');
  });

  it('formats pre-epoch instants correctly', () => {
    expect(Timestamp.fromNanos(-1n).toISOString('ns')).toBe('1969-12-31T23:59:59.999999999Z');
    expect(Timestamp.fromMillis(-1500).toISOString()).toBe('1969-12-31T23:59:58.500Z');
  });

  it('uses expanded years outside 0000–9999', () => {
    expect(Timestamp.fromCivil({ year: 10000, month: 1, day: 1 }).toISOString()).toBe(
      '+010000-01-01T00:00:00Z',
    );
    expect(Timestamp.fromCivil({ year: -1, month: 1, day: 1 }).toISOString()).toBe(
      '-000001-01-01T00:00:00Z',
    );
  });

  it('serialises to JSON as an RFC 3339 string', () => {
    expect(JSON.stringify({ t: Timestamp.fromMillis(0) })).toBe('{"t":"1970-01-01T00:00:00Z"}');
  });

  it('round-trips through parse for any instant', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -62_135_596_800_000_000_000n, max: 253_402_300_799_999_999_999n }),
        (nanos) => {
          const ts = Timestamp.fromNanos(nanos);
          expect(Timestamp.parse(ts.toISOString('ns')).nanos).toBe(nanos);
          expect(Timestamp.parse(ts.toISOString()).nanos).toBe(nanos);
        },
      ),
    );
  });
});

describe('Timestamp construction and arithmetic', () => {
  it('converts between units', () => {
    expect(Timestamp.fromSeconds(1.5).nanos).toBe(1_500_000_000n);
    expect(Timestamp.fromSeconds(10n).nanos).toBe(10_000_000_000n);
    expect(Timestamp.fromMillis(1.25).nanos).toBe(1_250_000n);
    expect(Timestamp.fromMicros(3n).nanos).toBe(3_000n);
    expect(Timestamp.fromMicros(3).nanos).toBe(3_000n);
    expect(Timestamp.fromDate(new Date(1234)).toMillis()).toBe(1234);
    expect(Timestamp.fromNanos(1_999_999n).toMillis()).toBe(1);
    expect(Timestamp.fromNanos(-1n).toMillis()).toBe(-1);
    expect(Timestamp.fromMillis(1500).toSeconds()).toBe(1.5);
    expect(Timestamp.fromMillis(42).toDate().getTime()).toBe(42);
  });

  it('rejects non-finite and invalid inputs', () => {
    expect(() => Timestamp.fromMillis(NaN)).toThrow(ValueTypeError);
    expect(() => Timestamp.fromSeconds(Infinity)).toThrow(ValueTypeError);
    expect(() => Timestamp.fromDate(new Date(NaN))).toThrow(ValueTypeError);
    expect(() => Timestamp.fromMicros(1.5)).toThrow(ValueTypeError);
    expect(() => Timestamp.fromCivil({ year: 2026, month: 2, day: 29 })).toThrow(ValueTypeError);
  });

  it('decomposes into seconds and nanos with a non-negative remainder', () => {
    expect(Timestamp.fromNanos(-1n).toSecondsAndNanos()).toEqual({
      seconds: -1n,
      nanos: 999_999_999,
    });
    expect(Timestamp.fromNanos(1_000_000_001n).toSecondsAndNanos()).toEqual({
      seconds: 1n,
      nanos: 1,
    });
  });

  it('adds, compares, and measures intervals', () => {
    const a = Timestamp.fromMillis(1000);
    const b = a.add(500_000_000n);
    expect(b.since(a)).toBe(500_000_000n);
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(Timestamp.fromMillis(1000))).toBe(0);
    expect(a.isBefore(b)).toBe(true);
    expect(b.isAfter(a)).toBe(true);
  });

  it('truncates to window boundaries, including before the epoch', () => {
    const minute = 60_000_000_000n;
    expect(Timestamp.parse('2026-01-01T10:15:42.5Z').truncate(minute).toISOString()).toBe(
      '2026-01-01T10:15:00Z',
    );
    expect(Timestamp.fromNanos(-1n).truncate(minute).nanos).toBe(-minute);
    expect(() => Timestamp.fromNanos(0n).truncate(0n)).toThrow(RangeError);
  });

  it('round-trips civil fields', () => {
    const fields = { year: 2026, month: 7, day: 4, hour: 13, minute: 5, second: 9, nanosecond: 42 };
    expect(Timestamp.fromCivil(fields).toCivil()).toEqual(fields);
  });
});
