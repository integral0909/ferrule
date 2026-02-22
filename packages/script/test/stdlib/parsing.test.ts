import { LogEvent, Timestamp } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import {
  compile,
  createDefaultImplementations,
  DEFAULT_LIMITS,
  EMPTY_SPAN,
  isFailure,
  parseAndCheck,
  RateLimiter,
  RegexValue,
  type CallArgs,
  type Failure,
  type RunCtx,
  type RuntimeValue,
} from '@ferrule/script';

const impls = createDefaultImplementations();

function makeCtx(): RunCtx {
  return {
    event: new LogEvent(),
    limits: DEFAULT_LIMITS,
    clock: () => Timestamp.now(),
    onLog: () => {},
    logLimiter: new RateLimiter(1000),
    emitted: [],
    currentSpan: EMPTY_SPAN,
  };
}

function call(
  name: string,
  positional: readonly RuntimeValue[],
  named: Record<string, RuntimeValue> = {},
): RuntimeValue | Failure {
  const implementation = impls.get(name);
  if (implementation === undefined) throw new Error(`no implementation registered for ${name}`);
  const args: CallArgs = {
    positional,
    named: new Map(Object.entries(named)),
    closures: [],
    positionalSupplied: positional.map(() => true),
  };
  return implementation.call(args, makeCtx(), EMPTY_SPAN);
}

function regex(source: string, flags = ''): RegexValue {
  return new RegexValue(new RegExp(source, flags), source, flags);
}

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

describe('parse_regex', () => {
  it('returns named capture groups as a string object', () => {
    const result = call('parse_regex', ['a=1 b=2', regex('(?<key>\\w+)=(?<val>\\d+)')]);
    expect(result).toEqual(
      new Map<string, unknown>([
        ['key', 'a'],
        ['val', '1'],
      ]),
    );
  });

  it('accepts a plain string pattern, compiled as regex source', () => {
    const result = call('parse_regex', ['a=1', '(?<key>\\w+)=(?<val>\\d+)']);
    expect(result).toEqual(
      new Map<string, unknown>([
        ['key', 'a'],
        ['val', '1'],
      ]),
    );
  });

  it('fails when there is no match', () => {
    expect(isFailure(call('parse_regex', ['xyz', regex('\\d+')]))).toBe(true);
  });

  it('fails when a string pattern is not a valid regex', () => {
    expect(isFailure(call('parse_regex', ['a', '(']))).toBe(true);
  });

  it('a group that did not participate becomes an empty string, not absent', () => {
    const result = call('parse_regex', ['y', regex('(?<a>x)|(?<b>y)')]) as Map<string, unknown>;
    expect(result.get('a')).toBe('');
    expect(result.get('b')).toBe('y');
  });

  it('numeric_groups: true also includes the whole match and positional groups', () => {
    const result = call('parse_regex', ['a=1', regex('(\\w+)=(\\d+)')], {
      numeric_groups: true,
    }) as Map<string, unknown>;
    expect(result.get('0')).toBe('a=1');
    expect(result.get('1')).toBe('a');
    expect(result.get('2')).toBe('1');
  });

  it('fails on a non-string value', () => {
    expect(isFailure(call('parse_regex', [1n, regex('.')]))).toBe(true);
  });
});

describe('compile_regex', () => {
  it('compiles a valid pattern', () => {
    expect(isFailure(call('compile_regex', ['^\\d+$']))).toBe(false);
  });

  it('fails on an invalid pattern', () => {
    expect(isFailure(call('compile_regex', ['(']))).toBe(true);
  });

  it('accepts flags', () => {
    const result = call('compile_regex', ['abc'], { flags: 'i' }) as RegexValue;
    expect(result.regex.test('ABC')).toBe(true);
  });

  it('the returned regex value works with matches()', () => {
    const re = call('compile_regex', ['^\\d+$']) as RegexValue;
    expect(call('matches', ['123', re])).toBe(true);
    expect(call('matches', ['abc', re])).toBe(false);
  });
});

describe('matches', () => {
  it('true when the pattern matches anywhere in the string', () => {
    expect(call('matches', ['hello world', regex('wor')])).toBe(true);
  });

  it('false when it does not match', () => {
    expect(call('matches', ['hello world', regex('xyz')])).toBe(false);
  });

  it('accepts a plain string pattern, compiled as regex source', () => {
    expect(call('matches', ['hello', '^h'])).toBe(true);
    expect(call('matches', ['hello', '^x'])).toBe(false);
  });

  it('fails when a string pattern is not a valid regex', () => {
    expect(isFailure(call('matches', ['x', '(']))).toBe(true);
  });

  it('repeated calls with the same string pattern reuse the cached compiled regex', () => {
    for (let i = 0; i < 5; i++) expect(call('matches', ['test123', '\\d+'])).toBe(true);
  });
});

describe('parse_regex_all', () => {
  it('returns one object per match, with named groups', () => {
    const result = call('parse_regex_all', ['a=1 b=22', regex('(?<key>\\w+)=(?<val>\\d+)')]);
    expect(result).toEqual([
      new Map<string, unknown>([
        ['match', 'a=1'],
        [
          'groups',
          new Map([
            ['key', 'a'],
            ['val', '1'],
          ]),
        ],
      ]),
      new Map<string, unknown>([
        ['match', 'b=22'],
        [
          'groups',
          new Map([
            ['key', 'b'],
            ['val', '22'],
          ]),
        ],
      ]),
    ]);
  });

  it('omits named groups that did not participate in a given match', () => {
    const result = call('parse_regex_all', ['xy', regex('(?<a>x)|(?<b>y)')]);
    expect(result).toEqual([
      new Map<string, unknown>([
        ['match', 'x'],
        ['groups', new Map([['a', 'x']])],
      ]),
      new Map<string, unknown>([
        ['match', 'y'],
        ['groups', new Map([['b', 'y']])],
      ]),
    ]);
  });

  it('returns an empty array when there are no matches', () => {
    expect(call('parse_regex_all', ['abc', regex('\\d+')])).toEqual([]);
  });

  it('runs globally even when the pattern was not compiled with the g flag', () => {
    const result = call('parse_regex_all', ['aaa', regex('a')]);
    expect(result).toHaveLength(3);
  });

  it('fails on a non-string text argument', () => {
    const result = call('parse_regex_all', [42n, regex('a')]);
    expect(isFailure(result)).toBe(true);
  });

  it('accepts a plain string pattern, compiled as regex source', () => {
    const result = call('parse_regex_all', ['a=1 b=2', '(?<key>\\w+)=(?<val>\\d+)']);
    expect(result).toEqual([
      new Map<string, unknown>([
        ['match', 'a=1'],
        [
          'groups',
          new Map([
            ['key', 'a'],
            ['val', '1'],
          ]),
        ],
      ]),
      new Map<string, unknown>([
        ['match', 'b=2'],
        [
          'groups',
          new Map([
            ['key', 'b'],
            ['val', '2'],
          ]),
        ],
      ]),
    ]);
  });

  it('fails when a string pattern is not a valid regex', () => {
    expect(isFailure(call('parse_regex_all', ['a', '(']))).toBe(true);
  });
});

describe('parse_key_value', () => {
  it('parses default-separated pairs, including a quoted value with spaces', () => {
    const result = call('parse_key_value', ['level=info msg="hit rate limit" retries=3']);
    expect(result).toEqual(
      new Map([
        ['level', 'info'],
        ['msg', 'hit rate limit'],
        ['retries', '3'],
      ]),
    );
  });

  it('respects custom field and pair separators', () => {
    const result = call('parse_key_value', ['a:1,b:2'], {
      field_separator: ':',
      pair_separator: ',',
    });
    expect(result).toEqual(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  });

  it('respects a custom quote character', () => {
    const result = call('parse_key_value', ["name='John Smith' age=30"], { quote: "'" });
    expect(result).toEqual(
      new Map([
        ['name', 'John Smith'],
        ['age', '30'],
      ]),
    );
  });

  it('handles unicode inside quoted values', () => {
    const result = call('parse_key_value', ['city="東京" country=japan']);
    expect(result).toEqual(
      new Map([
        ['city', '東京'],
        ['country', 'japan'],
      ]),
    );
  });

  it('ignores empty segments produced by runs of the pair separator', () => {
    const result = call('parse_key_value', ['a=1    b=2']);
    expect(result).toEqual(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  });

  it('returns an empty object for empty text', () => {
    expect(call('parse_key_value', [''])).toEqual(new Map());
  });

  it('fails when a pair has no field separator', () => {
    const result = call('parse_key_value', ['abc def=1']);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('abc');
  });

  it('fails on a non-string text argument', () => {
    expect(isFailure(call('parse_key_value', [null]))).toBe(true);
  });
});

describe('parse_int', () => {
  it('parses base-10 by default', () => {
    expect(call('parse_int', ['42'])).toBe(42n);
  });

  it('parses other radixes, including a leading sign', () => {
    expect(call('parse_int', ['ff'], { radix: 16n })).toBe(255n);
    expect(call('parse_int', ['-101'], { radix: 2n })).toBe(-5n);
    expect(call('parse_int', ['+10'], { radix: 8n })).toBe(8n);
  });

  it('accepts the int64 boundaries', () => {
    expect(call('parse_int', ['9223372036854775807'])).toBe(INT64_MAX);
    expect(call('parse_int', ['-9223372036854775808'])).toBe(INT64_MIN);
  });

  it('fails when the value overflows int64', () => {
    const result = call('parse_int', ['9223372036854775808']);
    expect(isFailure(result)).toBe(true);
  });

  it('fails on a digit outside the radix', () => {
    const result = call('parse_int', ['1g'], { radix: 16n });
    expect(isFailure(result)).toBe(true);
  });

  it('fails on a partial/invalid literal', () => {
    expect(isFailure(call('parse_int', ['12 34']))).toBe(true);
    expect(isFailure(call('parse_int', ['']))).toBe(true);
    expect(isFailure(call('parse_int', ['12.5']))).toBe(true);
  });

  it('fails on an out-of-range radix', () => {
    expect(isFailure(call('parse_int', ['10'], { radix: 1n }))).toBe(true);
    expect(isFailure(call('parse_int', ['10'], { radix: 37n }))).toBe(true);
  });
});

describe('parse_float', () => {
  it('parses plain decimals, signs, and exponents', () => {
    expect(call('parse_float', ['3.14'])).toBeCloseTo(3.14);
    expect(call('parse_float', ['-2.5e10'])).toBe(-2.5e10);
    expect(call('parse_float', ['1'])).toBe(1);
    expect(call('parse_float', ['.5'])).toBe(0.5);
  });

  it('trims surrounding whitespace', () => {
    expect(call('parse_float', [' 3.14 '])).toBeCloseTo(3.14);
  });

  it('rejects partial parses that JS parseFloat would accept', () => {
    expect(isFailure(call('parse_float', ['12abc']))).toBe(true);
    expect(isFailure(call('parse_float', ['1.2.3']))).toBe(true);
    expect(isFailure(call('parse_float', ['abc']))).toBe(true);
    expect(isFailure(call('parse_float', ['Infinity']))).toBe(true);
    expect(isFailure(call('parse_float', ['NaN']))).toBe(true);
    expect(isFailure(call('parse_float', ['']))).toBe(true);
  });
});

describe('parse_timestamp', () => {
  it('parses RFC 3339 when no format is given', () => {
    const result = call('parse_timestamp', ['2024-01-15T10:30:00Z']);
    expect(result).toEqual(Timestamp.parse('2024-01-15T10:30:00Z'));
  });

  it('fails on invalid RFC 3339 text', () => {
    expect(isFailure(call('parse_timestamp', ['not a timestamp']))).toBe(true);
  });

  it('parses using a given strftime format', () => {
    const result = call('parse_timestamp', ['2024-01-15 10:30:00'], {
      format: '%Y-%m-%d %H:%M:%S',
    });
    expect(result).toEqual(Timestamp.parse('2024-01-15T10:30:00Z'));
  });

  it('fails when text does not match the given format', () => {
    const result = call('parse_timestamp', ['not-a-date'], { format: '%Y-%m-%d' });
    expect(isFailure(result)).toBe(true);
  });
});

describe('parse_duration', () => {
  it('parses compound durations into nanoseconds', () => {
    expect(call('parse_duration', ['1h30m'])).toBe(5_400_000_000_000n);
    expect(call('parse_duration', ['250ms'])).toBe(250_000_000n);
  });

  it('accepts the int64-max boundary in nanoseconds', () => {
    expect(call('parse_duration', ['9223372036854775807ns'])).toBe(INT64_MAX);
  });

  it('fails when the duration overflows int64', () => {
    const result = call('parse_duration', ['9223372036854775808ns']);
    expect(isFailure(result)).toBe(true);
  });

  it('fails on invalid duration text', () => {
    expect(isFailure(call('parse_duration', ['abc']))).toBe(true);
    expect(isFailure(call('parse_duration', ['-5s']))).toBe(true);
  });
});

describe('parse_url', () => {
  it('parses every component of a full URL', () => {
    const result = call('parse_url', ['https://user:pass@example.com:8443/a/b?x=1&y=2#frag']);
    expect(result).toEqual(
      new Map<string, unknown>([
        ['scheme', 'https'],
        ['host', 'example.com'],
        ['port', 8443n],
        ['path', '/a/b'],
        ['query', 'x=1&y=2'],
        ['fragment', 'frag'],
        ['username', 'user'],
        ['password', 'pass'],
      ]),
    );
  });

  it('uses null for an unspecified port and empty strings for missing user info', () => {
    const result = call('parse_url', ['https://example.com/path']);
    expect(result).toEqual(
      new Map<string, unknown>([
        ['scheme', 'https'],
        ['host', 'example.com'],
        ['port', null],
        ['path', '/path'],
        ['query', ''],
        ['fragment', ''],
        ['username', ''],
        ['password', ''],
      ]),
    );
  });

  it('fails on an invalid URL', () => {
    expect(isFailure(call('parse_url', ['not a url']))).toBe(true);
  });
});

describe('parse_query_string', () => {
  it('parses simple key=value pairs', () => {
    const result = call('parse_query_string', ['a=1&b=2']);
    expect(result).toEqual(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  });

  it('strips a leading "?"', () => {
    const result = call('parse_query_string', ['?a=1']);
    expect(result).toEqual(new Map([['a', '1']]));
  });

  it('promotes a repeated key to an array of strings, in order', () => {
    const result = call('parse_query_string', ['a=1&a=2&a=3']);
    expect(result).toEqual(new Map([['a', ['1', '2', '3']]]));
  });

  it('percent-decodes unicode values', () => {
    const result = call('parse_query_string', ['name=%E6%9D%B1%E4%BA%AC']);
    expect(result).toEqual(new Map([['name', '東京']]));
  });

  it('returns an empty object for an empty string', () => {
    expect(call('parse_query_string', [''])).toEqual(new Map());
  });
});

// ---- end-to-end (parse -> check -> compile -> run) ---------------------------------------------

function compileSource(source: string) {
  const result = parseAndCheck(source);
  const diagnostics = [...result.parseDiagnostics, ...result.diagnostics];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `unexpected diagnostics: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
    );
  }
  return compile(result);
}

describe('parsing stdlib end-to-end', () => {
  it('parses a URL field through a compiled program', () => {
    const program = compileSource('.parsed = parse_url(.url)!');
    const outcome = program.run(LogEvent.from({ url: 'https://example.com:9000/api?ok=1' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      const parsed = outcome.events[0]!.fields.get('parsed');
      expect(parsed).toEqual(
        new Map<string, unknown>([
          ['scheme', 'https'],
          ['host', 'example.com'],
          ['port', 9000n],
          ['path', '/api'],
          ['query', 'ok=1'],
          ['fragment', ''],
          ['username', ''],
          ['password', ''],
        ]),
      );
    }
  });

  it('aborts on an invalid URL when handled with !', () => {
    const program = compileSource('.parsed = parse_url(.url)!');
    const outcome = program.run(LogEvent.from({ url: 'not a url' }));
    expect(outcome.kind).toBe('abort');
  });

  it('parses a duration field through a compiled program', () => {
    const program = compileSource('.timeout_ns = parse_duration(.timeout) ?? 0');
    const outcome = program.run(LogEvent.from({ timeout: '1h' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('timeout_ns')).toBe(3_600_000_000_000n);
    }
  });

  it('falls back through ?? when a duration fails to parse', () => {
    const program = compileSource('.timeout_ns = parse_duration(.timeout) ?? -1');
    const outcome = program.run(LogEvent.from({ timeout: 'nonsense' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('timeout_ns')).toBe(-1n);
    }
  });
});
