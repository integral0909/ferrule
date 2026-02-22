import { Timestamp } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import {
  createDefaultImplementations,
  Failure,
  isFailure,
  RateLimiter,
  RegexValue,
} from '@ferrule/script';
import { args, fakeCtx } from './helpers.js';

const impls = createDefaultImplementations();

function call(name: string, positional: readonly unknown[], named?: Record<string, unknown>) {
  const fn = impls.get(name);
  if (fn === undefined) throw new Error(`no implementation registered for '${name}'`);
  const namedMap = named === undefined ? undefined : new Map(Object.entries(named));
  return fn.call(args(positional as never, namedMap as never), fakeCtx(), { start: 0, end: 0 });
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

describe('is_* kind checks', () => {
  const cases: readonly [string, unknown][] = [
    ['is_null', null],
    ['is_bool', true],
    ['is_int', 1n],
    ['is_float', 1.5],
    ['is_string', 's'],
    ['is_bytes', new Uint8Array([1])],
    ['is_timestamp', Timestamp.now()],
    ['is_array', []],
    ['is_object', new Map()],
  ];

  for (const [name, matching] of cases) {
    it(`${name} is true for its own kind and false for others`, () => {
      expect(call(name, [matching])).toBe(true);
      const other = matching === null ? 1n : null;
      expect(call(name, [other])).toBe(false);
    });
  }

  it('is_regex recognises a regex value', () => {
    const re = new RegexValue(/x/, 'x', '');
    expect(call('is_regex', [re])).toBe(true);
    expect(call('is_regex', ['x'])).toBe(false);
  });
});

describe('to_int', () => {
  it('passes through an int', () => {
    expect(call('to_int', [5n])).toBe(5n);
  });
  it('truncates a float toward zero', () => {
    expect(call('to_int', [5.9])).toBe(5n);
    expect(call('to_int', [-5.9])).toBe(-5n);
  });
  it('parses a decimal string', () => {
    expect(call('to_int', ['42'])).toBe(42n);
    expect(call('to_int', ['-42'])).toBe(-42n);
  });
  it('fails on a non-numeric string', () => {
    expect(isFailure(call('to_int', ['abc']))).toBe(true);
  });
  it('converts bool', () => {
    expect(call('to_int', [true])).toBe(1n);
    expect(call('to_int', [false])).toBe(0n);
  });
  it('handles int64 boundaries', () => {
    expect(call('to_int', [INT64_MAX])).toBe(INT64_MAX);
    expect(call('to_int', [INT64_MIN])).toBe(INT64_MIN);
    expect(isFailure(call('to_int', [String(INT64_MAX) + '0']))).toBe(true);
  });
  it('fails on a non-finite float', () => {
    expect(isFailure(call('to_int', [Infinity]))).toBe(true);
    expect(isFailure(call('to_int', [NaN]))).toBe(true);
  });
});

describe('to_float', () => {
  it('parses a valid float string', () => {
    expect(call('to_float', ['3.5'])).toBe(3.5);
  });
  it('fails on garbage', () => {
    expect(isFailure(call('to_float', ['not a float']))).toBe(true);
  });
  it('converts an int exactly within safe range', () => {
    expect(call('to_float', [10n])).toBe(10);
  });
});

describe('to_bool', () => {
  it('parses common truthy/falsy words case-insensitively', () => {
    for (const w of ['true', 'True', 'YES', '1']) expect(call('to_bool', [w])).toBe(true);
    for (const w of ['false', 'False', 'NO', '0']) expect(call('to_bool', [w])).toBe(false);
  });
  it('treats null as false', () => {
    expect(call('to_bool', [null])).toBe(false);
  });
  it('fails on an unrecognised string', () => {
    expect(isFailure(call('to_bool', ['maybe']))).toBe(true);
  });
});

describe('to_timestamp', () => {
  it('parses RFC 3339', () => {
    const result = call('to_timestamp', ['2024-01-01T00:00:00Z']);
    expect(result).toBeInstanceOf(Timestamp);
  });
  it('fails on a malformed timestamp string', () => {
    expect(isFailure(call('to_timestamp', ['not a timestamp']))).toBe(true);
  });
  it('interprets an int as Unix seconds', () => {
    const result = call('to_timestamp', [0n]) as Timestamp;
    expect(result.toISOString()).toBe('1970-01-01T00:00:00Z');
  });
});

describe('type_of', () => {
  it('names every kind', () => {
    expect(call('type_of', [null])).toBe('null');
    expect(call('type_of', [1n])).toBe('int');
    expect(call('type_of', [1.5])).toBe('float');
    expect(call('type_of', ['s'])).toBe('string');
    expect(call('type_of', [[]])).toBe('array');
    expect(call('type_of', [new Map()])).toBe('object');
  });
});

describe('numbers', () => {
  it('abs handles int and float, including int64 min via wraparound', () => {
    expect(call('abs', [-5n])).toBe(5n);
    expect(call('abs', [-5.5])).toBe(5.5);
    // abs(INT64_MIN) overflows int64 and wraps back to INT64_MIN, matching `-` operator semantics.
    expect(call('abs', [INT64_MIN])).toBe(INT64_MIN);
  });

  it('floor/ceil round toward negative/positive infinity', () => {
    expect(call('floor', [1.9])).toBe(1);
    expect(call('ceil', [1.1])).toBe(2);
    expect(call('floor', [-1.1])).toBe(-2);
  });

  it('round respects precision', () => {
    // 1.615 is not exactly representable as a float64 (it's ~1.6149999999999999911...), so a
    // naive `round(v * 100) / 100` rounds it down to 1.61 rather than 1.62 - use a value that
    // does not sit on that representability edge, so this test isn't asserting float trivia.
    expect(call('round', [1.62], { precision: 2n })).toBeCloseTo(1.62, 10);
    expect(call('round', [1.626], { precision: 2n })).toBeCloseTo(1.63, 10);
    expect(call('round', [1.5])).toBe(2);
  });

  it('min/max use natural order', () => {
    expect(call('min', [3n, 1n])).toBe(1n);
    expect(call('max', [3n, 1n])).toBe(3n);
  });

  it('mod matches the % operator, including division-by-zero failure', () => {
    expect(call('mod', [7n, 3n])).toBe(1n);
    expect(isFailure(call('mod', [7n, 0n]))).toBe(true);
    expect(call('mod', [7.5, 2.0])).toBeCloseTo(1.5, 10);
  });

  it('now returns a timestamp from the run context clock', () => {
    const fixed = Timestamp.fromMillis(123_000);
    const fn = impls.get('now')!;
    const result = fn.call(args([]), fakeCtx({ clock: () => fixed }), { start: 0, end: 0 });
    expect(result).toBe(fixed);
  });

  it('format_timestamp and to_unix_timestamp round-trip a known instant', () => {
    const ts = Timestamp.fromCivil({ year: 2024, month: 3, day: 2, hour: 4, minute: 5, second: 6 });
    expect(call('format_timestamp', [ts, '%Y-%m-%d %H:%M:%S'])).toBe('2024-03-02 04:05:06');
    expect(call('to_unix_timestamp', [ts])).toBe(ts.toSecondsAndNanos().seconds);
    expect(call('to_unix_timestamp', [ts], { unit: 'ms' })).toBe(BigInt(ts.toMillis()));
  });
});

describe('assert/log/emit', () => {
  it('assert aborts (throws) when the condition is false', () => {
    const fn = impls.get('assert')!;
    expect(() => fn.call(args([false]), fakeCtx(), { start: 0, end: 0 })).toThrow();
  });
  it('assert passes through null when the condition is true', () => {
    const fn = impls.get('assert')!;
    expect(fn.call(args([true]), fakeCtx(), { start: 0, end: 0 })).toBe(null);
  });

  it('log calls onLog with the message, respecting the rate limiter', () => {
    const seen: string[] = [];
    const fn = impls.get('log')!;
    const ctx = fakeCtx({
      onLog: (e) =>
        seen.push(typeof e.message === 'string' ? e.message : JSON.stringify(e.message)),
      logLimiter: new RateLimiter(1),
    });
    fn.call(args(['hi']), ctx, { start: 0, end: 0 });
    fn.call(args(['dropped by the limiter']), ctx, { start: 0, end: 0 });
    expect(seen).toEqual(['hi']);
  });

  it('emit pushes a log event built from an object argument', () => {
    const fn = impls.get('emit')!;
    const ctx = fakeCtx();
    fn.call(args([new Map([['kind', 'child']])]), ctx, { start: 0, end: 0 });
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]!.fields.get('kind')).toBe('child');
  });

  it('emit rejects a regex value', () => {
    const fn = impls.get('emit')!;
    const ctx = fakeCtx();
    expect(() =>
      fn.call(args([new RegexValue(/x/, 'x', '')]), ctx, { start: 0, end: 0 }),
    ).toThrow();
  });
});

describe('Failure sentinel', () => {
  it('isFailure distinguishes a Failure from a real value', () => {
    expect(isFailure(new Failure('x'))).toBe(true);
    expect(isFailure('x')).toBe(false);
    expect(isFailure(null)).toBe(false);
  });
});
