import { LogEvent, Timestamp } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import type { Failure } from '@ferrule/script';
import {
  compile,
  DEFAULT_LIMITS,
  EMPTY_SPAN,
  FunctionRegistry,
  ImplementationRegistry,
  isFailure,
  parseAndCheck,
  RateLimiter,
  RegexValue,
  type CallArgs,
  type RunCtx,
  type RuntimeValue,
} from '@ferrule/script';
import { registerStrings } from '../../src/stdlib/strings.js';

// ---- direct implementation call helper --------------------------------------------------------

const impls = new ImplementationRegistry();
registerStrings(new FunctionRegistry(), impls);

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
  named: Readonly<Record<string, RuntimeValue>> = {},
): RuntimeValue | Failure {
  const implementation = impls.get(name);
  if (implementation === undefined) throw new Error(`no implementation registered for '${name}'`);
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

// ---- end-to-end compile helper -----------------------------------------------------------------

function compileSource(source: string) {
  // `parseAndCheck` defaults to `createDefaultRegistry()`, which already registers the full
  // standard library (including this module's functions), matching `test/compile/smoke.test.ts`.
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

// ---- trim / trim_start / trim_end -----------------------------------------------------------

describe('trim / trim_start / trim_end', () => {
  it('trims whitespace from both ends', () => {
    expect(call('trim', ['  hi  '])).toBe('hi');
  });

  it('trims whitespace from only the start', () => {
    expect(call('trim_start', ['  hi  '])).toBe('hi  ');
  });

  it('trims whitespace from only the end', () => {
    expect(call('trim_end', ['  hi  '])).toBe('  hi');
  });

  it('leaves a string with no surrounding whitespace unchanged', () => {
    expect(call('trim', ['hi'])).toBe('hi');
  });

  for (const name of ['trim', 'trim_start', 'trim_end']) {
    it(`${name} fails on a non-string`, () => {
      const result = call(name, [42n]);
      expect(isFailure(result)).toBe(true);
      expect((result as Failure).message).toContain('int');
    });
  }
});

// ---- contains / starts_with / ends_with ------------------------------------------------------

describe('contains / starts_with / ends_with', () => {
  it('contains finds a substring', () => {
    expect(call('contains', ['hello world', 'world'])).toBe(true);
    expect(call('contains', ['hello world', 'xyz'])).toBe(false);
  });

  it('starts_with checks the prefix', () => {
    expect(call('starts_with', ['/api/users', '/api/'])).toBe(true);
    expect(call('starts_with', ['/api/users', '/admin/'])).toBe(false);
  });

  it('ends_with checks the suffix', () => {
    expect(call('ends_with', ['report.json', '.json'])).toBe(true);
    expect(call('ends_with', ['report.json', '.csv'])).toBe(false);
  });

  it('fails when the first argument is not a string', () => {
    const result = call('contains', [42n, 'x']);
    expect(isFailure(result)).toBe(true);
  });

  it('fails when the second argument is not a string', () => {
    const result = call('starts_with', ['hello', 42n]);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('prefix');
  });
});

// ---- replace ------------------------------------------------------------------------------------

describe('replace', () => {
  it('replaces every occurrence of a literal string by default', () => {
    expect(call('replace', ['a-b-a-b', '-', '+'])).toBe('a+b+a+b');
  });

  it('replaces at most `count` occurrences of a literal string', () => {
    expect(call('replace', ['a-b-a-b', '-', '+'], { count: 1n })).toBe('a+b-a-b');
  });

  it('replaces every match of a regex by default', () => {
    expect(call('replace', ['a1b22c333', regex('\\d+'), 'X'])).toBe('aXbXcX');
  });

  it('replaces at most `count` matches of a regex', () => {
    expect(call('replace', ['a1b22c333', regex('\\d+', 'g'), 'X'], { count: 2n })).toBe('aXbXc333');
  });

  it('handles an empty literal pattern by inserting between every code unit', () => {
    expect(call('replace', ['abc', '', '-'])).toBe('-a-b-c-');
  });

  it('fails when value is not a string', () => {
    const result = call('replace', [42n, 'a', 'b']);
    expect(isFailure(result)).toBe(true);
  });

  it('fails when pattern is neither a string nor a regex', () => {
    const result = call('replace', ['abc', 42n, 'b']);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('pattern');
  });

  it('fails when replacement is not a string', () => {
    const result = call('replace', ['abc', 'a', 42n]);
    expect(isFailure(result)).toBe(true);
  });

  it('fails when count is not an int', () => {
    const result = call('replace', ['abc', 'a', 'b'], { count: 'x' });
    expect(isFailure(result)).toBe(true);
  });
});

// ---- split -------------------------------------------------------------------------------------

describe('split', () => {
  it('splits on every occurrence of a literal separator', () => {
    expect(call('split', ['a,b,c', ','])).toEqual(['a', 'b', 'c']);
  });

  it('limits the number of elements, leaving the remainder unsplit', () => {
    expect(call('split', ['a,b,c,d', ','], { limit: 2n })).toEqual(['a', 'b,c,d']);
  });

  it('splits on every match of a regex separator', () => {
    expect(call('split', ['a1b22c', regex('\\d+')])).toEqual(['a', 'b', 'c']);
  });

  it('limits regex splitting the same way', () => {
    expect(call('split', ['a1b22c', regex('\\d+')], { limit: 2n })).toEqual(['a', 'b22c']);
  });

  it('splits into individual code units on an empty separator', () => {
    expect(call('split', ['abc', ''])).toEqual(['a', 'b', 'c']);
  });

  it('respects limit with an empty separator', () => {
    expect(call('split', ['abc', ''], { limit: 2n })).toEqual(['a', 'bc']);
  });

  it('fails when value is not a string', () => {
    expect(isFailure(call('split', [42n, ',']))).toBe(true);
  });

  it('fails when separator is neither a string nor a regex', () => {
    const result = call('split', ['abc', 42n]);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('separator');
  });

  it('fails when limit is not an int', () => {
    expect(isFailure(call('split', ['abc', ','], { limit: 'x' }))).toBe(true);
  });
});

// ---- join --------------------------------------------------------------------------------------

describe('join', () => {
  it('joins strings with a separator', () => {
    expect(call('join', [['a', 'b', 'c'], '-'])).toBe('a-b-c');
  });

  it('returns an empty string for an empty array', () => {
    expect(call('join', [[], '-'])).toBe('');
  });

  it('fails when value is not an array', () => {
    expect(isFailure(call('join', ['abc', '-']))).toBe(true);
  });

  it('fails when separator is not a string', () => {
    expect(isFailure(call('join', [['a'], 42n]))).toBe(true);
  });

  it('fails when an element is not a string, naming its kind', () => {
    const result = call('join', [['a', 1n, 'c'], '-']);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('int');
  });
});

// ---- slice ---------------------------------------------------------------------------------------

describe('slice', () => {
  it('slices with a positive start and end', () => {
    expect(call('slice', ['hello', 1n], { end: 3n })).toBe('el');
  });

  it('slices with a negative start, counting from the end', () => {
    expect(call('slice', ['hello', -3n])).toBe('llo');
  });

  it('defaults end to the end of the string', () => {
    expect(call('slice', ['hello', 2n])).toBe('llo');
  });

  it('operates on UTF-16 code units, which can split a surrogate pair', () => {
    const s = 'a\u{1F44D}b'; // "a👍b": 'a' (1 unit) + 👍 (surrogate pair, 2 units) + 'b' (1 unit)
    expect(s.length).toBe(4);
    const result = call('slice', [s, 1n], { end: 3n });
    expect(typeof result).toBe('string');
    const sliced = result as string;
    expect(sliced.length).toBe(2);
    // the slice grabbed exactly the two surrogate code units of the emoji, not the emoji "as one character"
    expect(sliced.charCodeAt(0)).toBe(s.charCodeAt(1));
    expect(sliced.charCodeAt(1)).toBe(s.charCodeAt(2));
  });

  it('fails when value is not a string', () => {
    expect(isFailure(call('slice', [42n, 0n]))).toBe(true);
  });

  it('fails when start is not an int', () => {
    expect(isFailure(call('slice', ['hello', 'x']))).toBe(true);
  });

  it('fails when end is not an int', () => {
    expect(isFailure(call('slice', ['hello', 0n], { end: 'x' }))).toBe(true);
  });
});

// ---- pad_start / pad_end -------------------------------------------------------------------------

describe('pad_start / pad_end', () => {
  it('pads at the start with a custom pad string', () => {
    expect(call('pad_start', ['5', 3n], { pad: '0' })).toBe('005');
  });

  it('pads at the end with a custom pad string', () => {
    expect(call('pad_end', ['5', 3n], { pad: '0' })).toBe('500');
  });

  it('defaults the pad to a single space', () => {
    expect(call('pad_start', ['5', 3n])).toBe('  5');
  });

  it('leaves a string already at least as wide as `width` unchanged', () => {
    expect(call('pad_start', ['hello', 3n])).toBe('hello');
  });

  it('pads by UTF-16 code units, so a surrogate pair counts as two', () => {
    const emoji = '\u{1F44D}'; // 👍, a 2-code-unit surrogate pair
    expect(emoji.length).toBe(2);
    expect(call('pad_start', [emoji, 4n], { pad: '-' })).toBe(`--${emoji}`);
  });

  it('fails when value is not a string', () => {
    expect(isFailure(call('pad_start', [42n, 3n]))).toBe(true);
  });

  it('fails when width is not an int', () => {
    expect(isFailure(call('pad_start', ['5', 'x']))).toBe(true);
  });

  it('fails when pad is not a string', () => {
    expect(isFailure(call('pad_start', ['5', 3n], { pad: 42n }))).toBe(true);
  });
});

// ---- truncate --------------------------------------------------------------------------------

describe('truncate', () => {
  it('returns a string that already fits unchanged', () => {
    expect(call('truncate', ['hi', 10n])).toBe('hi');
  });

  it('truncates and appends the default suffix, staying within the budget', () => {
    const result = call('truncate', ['hello world', 8n]) as string;
    expect(result).toBe('hello...');
    expect(result.length).toBe(8);
  });

  it('truncates with a custom suffix', () => {
    const result = call('truncate', ['hello world', 8n], { suffix: '~' }) as string;
    expect(result).toBe('hello w~');
    expect(result.length).toBe(8);
  });

  it('clamps the result when the suffix alone is longer than length', () => {
    const result = call('truncate', ['hello', 2n], { suffix: '...' }) as string;
    expect(result.length).toBe(2);
    expect(result).toBe('..');
  });

  it('returns an empty string when length is zero or negative', () => {
    expect(call('truncate', ['hello', 0n])).toBe('');
    expect(call('truncate', ['hello', -5n])).toBe('');
  });

  it('truncates by UTF-16 code units, which can split a surrogate pair', () => {
    const s = 'a\u{1F44D}b';
    expect(s.length).toBe(4);
    const result = call('truncate', [s, 2n], { suffix: '' }) as string;
    expect(result.length).toBe(2);
    expect(result.charCodeAt(0)).toBe(s.charCodeAt(0));
    expect(result.charCodeAt(1)).toBe(s.charCodeAt(1));
  });

  it('fails when value is not a string', () => {
    expect(isFailure(call('truncate', [42n, 5n]))).toBe(true);
  });

  it('fails when length is not an int', () => {
    expect(isFailure(call('truncate', ['hi', 'x']))).toBe(true);
  });

  it('fails when suffix is not a string', () => {
    expect(isFailure(call('truncate', ['hi', 5n], { suffix: 42n }))).toBe(true);
  });
});

// ---- strip_ansi ------------------------------------------------------------------------------

describe('strip_ansi', () => {
  it('removes SGR color codes', () => {
    expect(call('strip_ansi', ['\u001b[31mred\u001b[0m'])).toBe('red');
  });

  it('leaves a plain string unchanged', () => {
    expect(call('strip_ansi', ['plain text'])).toBe('plain text');
  });

  it('fails on a non-string', () => {
    expect(isFailure(call('strip_ansi', [42n]))).toBe(true);
  });
});

// ---- format ------------------------------------------------------------------------------------

describe('format', () => {
  it('substitutes bare placeholders left to right', () => {
    expect(call('format', ['{} + {} = {}', [1n, 2n, 3n]])).toBe('1 + 2 = 3');
  });

  it('substitutes explicit indices regardless of order', () => {
    expect(call('format', ['{1} then {0}', ['a', 'b']])).toBe('b then a');
  });

  it('renders values the way string interpolation does', () => {
    expect(call('format', ['value: {}', [true]])).toBe('value: true');
    expect(call('format', ['value: {}', [null]])).toBe('value: null');
  });

  it('fails when a bare placeholder index is out of range', () => {
    const result = call('format', ['{} {}', ['only one']]);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('out of range');
  });

  it('fails when an explicit placeholder index is out of range', () => {
    expect(isFailure(call('format', ['{5}', ['a']]))).toBe(true);
  });

  it('fails on an unmatched opening brace', () => {
    const result = call('format', ['hello {', []]);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain("'{'");
  });

  it('fails on an unmatched closing brace', () => {
    const result = call('format', ['hello }', []]);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain("'}'");
  });

  it('fails when template is not a string', () => {
    expect(isFailure(call('format', [42n, []]))).toBe(true);
  });

  it('fails when args is not an array', () => {
    expect(isFailure(call('format', ['{}', 'not an array']))).toBe(true);
  });
});

// ---- repeat --------------------------------------------------------------------------------------

describe('repeat', () => {
  it('repeats a string count times', () => {
    expect(call('repeat', ['ab', 3n])).toBe('ababab');
  });

  it('returns an empty string for count 0', () => {
    expect(call('repeat', ['ab', 0n])).toBe('');
  });

  it('fails on a negative count', () => {
    const result = call('repeat', ['ab', -1n]);
    expect(isFailure(result)).toBe(true);
    expect((result as Failure).message).toContain('non-negative');
  });

  it('fails when value is not a string', () => {
    expect(isFailure(call('repeat', [42n, 3n]))).toBe(true);
  });

  it('fails when count is not an int', () => {
    expect(isFailure(call('repeat', ['ab', 'x']))).toBe(true);
  });

  it('aborts via a resource-limit signal instead of building a huge string', () => {
    expect(() => call('repeat', ['ab', 10_000_000n])).toThrow();
  });
});

// ---- end-to-end (through the real compiler) ----------------------------------------------------

describe('strings stdlib, end to end', () => {
  it('replace runs through the compiler', () => {
    const program = compileSource('.message = replace(.message, "secret", "***")!');
    const outcome = program.run(LogEvent.from({ message: 'the secret is out' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('message')).toBe('the *** is out');
    }
  });

  it('split runs through the compiler', () => {
    const program = compileSource('.parts = split(.csv, ",")!');
    const outcome = program.run(LogEvent.from({ csv: 'a,b,c' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('parts')).toEqual(['a', 'b', 'c']);
    }
  });

  it('format runs through the compiler', () => {
    const program = compileSource('.line = format("{} says {}", [.name, .msg])!');
    const outcome = program.run(LogEvent.from({ name: 'alice', msg: 'hi' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('line')).toBe('alice says hi');
    }
  });

  it('format aborts the event on an out-of-range placeholder', () => {
    const program = compileSource('.line = format("{1}", [.a])!');
    const outcome = program.run(LogEvent.from({ a: 'x' }));
    expect(outcome.kind).toBe('abort');
  });

  it('truncate runs through the compiler', () => {
    const program = compileSource('.short = truncate(.message, 8)!');
    const outcome = program.run(LogEvent.from({ message: 'hello world' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('short')).toBe('hello...');
    }
  });
});
