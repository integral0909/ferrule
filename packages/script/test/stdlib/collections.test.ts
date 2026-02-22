import { LogEvent, type Value, type ValueMap } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import {
  compile,
  createRunCtx,
  EMPTY_SPAN,
  Failure,
  FunctionRegistry,
  ImplementationRegistry,
  parseAndCheck,
  RateLimiter,
  RegexValue,
  type CallArgs,
  type CompiledClosure,
  type RunCtx,
  type RuntimeValue,
} from '@ferrule/script';
import { registerCollections } from '../../src/stdlib/collections.js';

// ---- test scaffolding -----------------------------------------------------------------------

function makeCtx(): RunCtx {
  return createRunCtx(LogEvent.from({}), undefined, new RateLimiter(1000), EMPTY_SPAN);
}

function makeArgs(
  positional: readonly RuntimeValue[],
  named: Readonly<Record<string, RuntimeValue>> = {},
  closures: readonly CompiledClosure[] = [],
): CallArgs {
  return {
    positional,
    named: new Map(Object.entries(named)),
    closures,
    positionalSupplied: positional.map(() => true),
  };
}

function implementations(): ImplementationRegistry {
  const impls = new ImplementationRegistry();
  registerCollections(new FunctionRegistry(), impls);
  return impls;
}

function call(
  name: string,
  positional: readonly RuntimeValue[],
  named: Readonly<Record<string, RuntimeValue>> = {},
) {
  const impl = implementations().get(name);
  if (impl === undefined) throw new Error(`no implementation registered for ${name}`);
  return impl.call(makeArgs(positional, named), makeCtx(), EMPTY_SPAN);
}

function callWithClosure(
  name: string,
  positional: readonly RuntimeValue[],
  closure: CompiledClosure,
) {
  const impl = implementations().get(name);
  if (impl === undefined) throw new Error(`no implementation registered for ${name}`);
  return impl.call(makeArgs(positional, {}, [closure]), makeCtx(), EMPTY_SPAN);
}

function obj(entries: readonly (readonly [string, Value])[]): ValueMap {
  return new Map(entries);
}

// ---- end-to-end compile helper ----------------------------------------------------------------

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

describe('collections: keys/values', () => {
  it('keys returns field names in insertion order', () => {
    expect(
      call('keys', [
        obj([
          ['b', 1n],
          ['a', 2n],
        ]),
      ]),
    ).toEqual(['b', 'a']);
  });

  it('keys of an empty object is an empty array', () => {
    expect(call('keys', [obj([])])).toEqual([]);
  });

  it('keys fails for a non-object', () => {
    expect(call('keys', ['not an object'])).toBeInstanceOf(Failure);
  });

  it('values returns field values in insertion order', () => {
    expect(
      call('values', [
        obj([
          ['a', 1n],
          ['b', 'x'],
        ]),
      ]),
    ).toEqual([1n, 'x']);
  });

  it('values fails for a non-object', () => {
    expect(call('values', [42n])).toBeInstanceOf(Failure);
  });
});

describe('collections: get/set', () => {
  it('get reads a nested path', () => {
    const root = obj([['a', obj([['b', [1n, 2n, 3n]]])]]);
    expect(call('get', [root, ['a', 'b', 1n]])).toBe(2n);
  });

  it('get returns the whole value for an empty path', () => {
    const root = obj([['a', 1n]]);
    expect(call('get', [root, []])).toBe(root);
  });

  it('get fails when nothing exists at the path', () => {
    const root = obj([['a', 1n]]);
    expect(call('get', [root, ['missing']])).toBeInstanceOf(Failure);
  });

  it('get fails for a malformed path array', () => {
    const root = obj([['a', 1n]]);
    expect(call('get', [root, [true]])).toBeInstanceOf(Failure);
    expect(call('get', [root, 'not-an-array'])).toBeInstanceOf(Failure);
  });

  it('set writes a nested path, creating intermediate containers', () => {
    const root = obj([]);
    const result = call('set', [root, ['a', 'b'], 42n]);
    expect(result).toEqual(obj([['a', obj([['b', 42n]])]]));
  });

  it('set with an empty path returns new_value directly', () => {
    expect(call('set', [obj([['a', 1n]]), [], 'replaced'])).toBe('replaced');
  });

  it('set fails for a malformed path array', () => {
    expect(call('set', [obj([]), [1.5], 'x'])).toBeInstanceOf(Failure);
  });
});

describe('collections: merge', () => {
  it('shallow-merges, with b winning on conflicts', () => {
    const a = obj([
      ['x', 1n],
      ['y', 2n],
    ]);
    const b = obj([
      ['y', 3n],
      ['z', 4n],
    ]);
    expect(call('merge', [a, b])).toEqual(
      obj([
        ['x', 1n],
        ['y', 3n],
        ['z', 4n],
      ]),
    );
    // inputs are untouched
    expect(a).toEqual(
      obj([
        ['x', 1n],
        ['y', 2n],
      ]),
    );
  });

  it('deep-merges nested objects when both sides are objects', () => {
    const a = obj([
      [
        'nested',
        obj([
          ['x', 1n],
          ['y', 2n],
        ]),
      ],
    ]);
    const b = obj([
      [
        'nested',
        obj([
          ['y', 3n],
          ['z', 4n],
        ]),
      ],
    ]);
    const result = call('merge', [a, b], { deep: true });
    expect(result).toEqual(
      obj([
        [
          'nested',
          obj([
            ['x', 1n],
            ['y', 3n],
            ['z', 4n],
          ]),
        ],
      ]),
    );
    // inputs are untouched
    expect(a).toEqual(
      obj([
        [
          'nested',
          obj([
            ['x', 1n],
            ['y', 2n],
          ]),
        ],
      ]),
    );
  });

  it('deep merge overwrites (does not merge) when kinds differ', () => {
    const a = obj([['x', obj([['a', 1n]])]]);
    const b = obj([['x', 5n]]);
    expect(call('merge', [a, b], { deep: true })).toEqual(obj([['x', 5n]]));
  });

  it('fails for non-object arguments', () => {
    expect(call('merge', [obj([]), 'not an object'])).toBeInstanceOf(Failure);
  });

  it('fails deep merge past the maximum nesting depth', () => {
    let a: ValueMap = obj([['leaf', 1n]]);
    let b: ValueMap = obj([['leaf', 2n]]);
    for (let i = 0; i < 100; i++) {
      a = obj([['nested', a]]);
      b = obj([['nested', b]]);
    }
    expect(call('merge', [a, b], { deep: true })).toBeInstanceOf(Failure);
  });
});

describe('collections: compact', () => {
  it('removes null elements from an array by default', () => {
    expect(call('compact', [[1n, null, 2n, null]])).toEqual([1n, 2n]);
  });

  it('removes null fields from an object by default', () => {
    expect(
      call('compact', [
        obj([
          ['a', 1n],
          ['b', null],
        ]),
      ]),
    ).toEqual(obj([['a', 1n]]));
  });

  it('also removes empty strings/arrays/objects when remove_empty is true', () => {
    const input = [1n, '', [], obj([]), null, 'x'];
    expect(call('compact', [input], { remove_empty: true })).toEqual([1n, 'x']);
  });

  it('remove_null: false keeps nulls', () => {
    expect(call('compact', [[1n, null]], { remove_null: false })).toEqual([1n, null]);
  });

  it('handles empty input', () => {
    expect(call('compact', [[]])).toEqual([]);
    expect(call('compact', [obj([])])).toEqual(obj([]));
  });

  it('fails for a non-array, non-object value', () => {
    expect(call('compact', ['nope'])).toBeInstanceOf(Failure);
  });
});

describe('collections: flatten/unflatten', () => {
  it('flattens nested objects with the default separator', () => {
    const input = obj([
      [
        'a',
        obj([
          ['b', 1n],
          ['c', 2n],
        ]),
      ],
    ]);
    expect(call('flatten', [input])).toEqual(
      obj([
        ['a.b', 1n],
        ['a.c', 2n],
      ]),
    );
  });

  it('flattens with a custom separator', () => {
    const input = obj([['a', obj([['b', 1n]])]]);
    expect(call('flatten', [input], { separator: '/' })).toEqual(obj([['a/b', 1n]]));
  });

  it('treats arrays as leaves', () => {
    const input = obj([['a', [1n, 2n]]]);
    expect(call('flatten', [input])).toEqual(obj([['a', [1n, 2n]]]));
  });

  it('treats an empty nested object as a leaf', () => {
    const input = obj([['a', obj([])]]);
    expect(call('flatten', [input])).toEqual(obj([['a', obj([])]]));
  });

  it('fails for a non-object', () => {
    expect(call('flatten', ['nope'])).toBeInstanceOf(Failure);
  });

  it('unflatten is the inverse of flatten for a nested object with no arrays', () => {
    const original = obj([
      [
        'a',
        obj([
          ['b', 1n],
          ['c', obj([['d', 'deep']])],
        ]),
      ],
      ['top', true],
    ]);
    const flat = call('flatten', [original]);
    expect(flat).not.toBeInstanceOf(Failure);
    const roundTripped = call('unflatten', [flat as RuntimeValue]);
    expect(roundTripped).toEqual(original);
  });

  it('unflatten fails when a key path conflicts with an existing leaf', () => {
    const input = obj([
      ['a', 1n],
      ['a.b', 2n],
    ]);
    expect(call('unflatten', [input])).toBeInstanceOf(Failure);
  });

  it('unflatten fails when a longer path is defined before the conflicting leaf', () => {
    const input = obj([
      ['a.b', 2n],
      ['a', 1n],
    ]);
    expect(call('unflatten', [input])).toBeInstanceOf(Failure);
  });

  it('unflatten fails for a non-object', () => {
    expect(call('unflatten', [42n])).toBeInstanceOf(Failure);
  });
});

describe('collections: map_keys', () => {
  it('applies a closure to every key', () => {
    const upper: CompiledClosure = (args) => (args[0] as string).toUpperCase();
    const result = callWithClosure(
      'map_keys',
      [
        obj([
          ['a', 1n],
          ['b', 2n],
        ]),
      ],
      upper,
    );
    expect(result).toEqual(
      obj([
        ['A', 1n],
        ['B', 2n],
      ]),
    );
  });

  it('the later key wins when the closure produces a collision', () => {
    const constantKey: CompiledClosure = () => 'same';
    const result = callWithClosure(
      'map_keys',
      [
        obj([
          ['a', 1n],
          ['b', 2n],
        ]),
      ],
      constantKey,
    );
    expect(result).toEqual(obj([['same', 2n]]));
  });

  it('fails when the closure does not return a string', () => {
    const badClosure: CompiledClosure = () => 42n;
    const result = callWithClosure('map_keys', [obj([['a', 1n]])], badClosure);
    expect(result).toBeInstanceOf(Failure);
  });

  it('propagates a Failure returned by the closure', () => {
    const failingClosure: CompiledClosure = () => new Failure('boom');
    const result = callWithClosure('map_keys', [obj([['a', 1n]])], failingClosure);
    expect(result).toBeInstanceOf(Failure);
    expect((result as Failure).message).toBe('boom');
  });

  it('fails for a non-object input', () => {
    const identity: CompiledClosure = (args) => args[0] as string;
    expect(callWithClosure('map_keys', ['nope'], identity)).toBeInstanceOf(Failure);
  });
});

describe('collections: includes', () => {
  it('finds structurally equal elements among mixed kinds', () => {
    expect(call('includes', [[1n, 'a', true, null], 'a'])).toBe(true);
    expect(call('includes', [[1n, 'a', true, null], null])).toBe(true);
    expect(call('includes', [[1n, 'a', true, null], false])).toBe(false);
  });

  it('two regex values are only equal by reference', () => {
    // An array containing a regex can never be built through the compiler (RuntimeValue's array
    // case is `Value[]`, which excludes RegexValue - see the README's "regex values cannot be
    // stored in ... arrays" gap), but `includes`'s implementation should still behave sanely if
    // one somehow reaches it, so this calls it directly with a hand-built, type-unchecked array.
    const re = new RegexValue(/x/, 'x', '');
    const sameRef = call('includes', [[re], re]);
    const differentRef = call('includes', [[new RegexValue(/x/, 'x', '')], re]);
    expect(sameRef).toBe(true);
    expect(differentRef).toBe(false);
  });

  it('fails for a non-array', () => {
    expect(call('includes', ['nope', 1n])).toBeInstanceOf(Failure);
  });
});

describe('collections: append/push', () => {
  it('concatenates two arrays without mutating either', () => {
    const a = [1n, 2n];
    const b = [3n];
    expect(call('append', [a, b])).toEqual([1n, 2n, 3n]);
    expect(a).toEqual([1n, 2n]);
    expect(b).toEqual([3n]);
  });

  it('append fails for non-array arguments', () => {
    expect(call('append', [[1n], 'nope'])).toBeInstanceOf(Failure);
  });

  it('push returns a new array with the element appended, without mutating the input', () => {
    const original = [1n, 2n];
    const result = call('push', [original, 3n]);
    expect(result).toEqual([1n, 2n, 3n]);
    expect(original).toEqual([1n, 2n]);
  });

  it('push fails for a non-array', () => {
    expect(call('push', ['nope', 1n])).toBeInstanceOf(Failure);
  });
});

describe('collections: unique', () => {
  it('dedups mixed-kind elements, keeping the first occurrence', () => {
    expect(call('unique', [[1n, 'a', 1n, 'a', true, true, null, null]])).toEqual([
      1n,
      'a',
      true,
      null,
    ]);
  });

  it('handles an empty array', () => {
    expect(call('unique', [[]])).toEqual([]);
  });

  it('fails for a non-array', () => {
    expect(call('unique', ['nope'])).toBeInstanceOf(Failure);
  });
});

describe('collections: sort', () => {
  it('sorts mixed-kind elements by natural order', () => {
    expect(call('sort', [['a', 3n, null, true]])).toEqual([null, true, 3n, 'a']);
  });

  it('sorts descending', () => {
    expect(call('sort', [[3n, 1n, 2n]], { descending: true })).toEqual([3n, 2n, 1n]);
  });

  it('does not mutate the input array', () => {
    const input = [3n, 1n, 2n];
    call('sort', [input]);
    expect(input).toEqual([3n, 1n, 2n]);
  });

  it('fails if any element is a regex', () => {
    // See the comment in the `includes` regex test above: this array is not constructible
    // through the compiler, only through a direct implementation call like this one.
    expect(call('sort', [[new RegexValue(/x/, 'x', '')]])).toBeInstanceOf(Failure);
  });

  it('fails for a non-array', () => {
    expect(call('sort', ['nope'])).toBeInstanceOf(Failure);
  });
});

describe('collections: chunks', () => {
  it('splits an array into chunks, with a shorter last chunk', () => {
    expect(call('chunks', [[1n, 2n, 3n, 4n, 5n], 2n])).toEqual([[1n, 2n], [3n, 4n], [5n]]);
  });

  it('fails when size is less than 1', () => {
    expect(call('chunks', [[1n, 2n], 0n])).toBeInstanceOf(Failure);
    expect(call('chunks', [[1n, 2n], -1n])).toBeInstanceOf(Failure);
  });

  it('fails for a non-array or non-int size', () => {
    expect(call('chunks', ['nope', 2n])).toBeInstanceOf(Failure);
    expect(call('chunks', [[1n], 'nope'])).toBeInstanceOf(Failure);
  });
});

describe('collections: zip', () => {
  it('pairs elements up to the length of the shorter array', () => {
    expect(
      call('zip', [
        [1n, 2n, 3n],
        ['a', 'b'],
      ]),
    ).toEqual([
      [1n, 'a'],
      [2n, 'b'],
    ]);
  });

  it('handles an empty array', () => {
    expect(call('zip', [[], ['a']])).toEqual([]);
  });

  it('fails for non-array arguments', () => {
    expect(call('zip', ['nope', []])).toBeInstanceOf(Failure);
  });
});

describe('collections: end-to-end compiled programs', () => {
  it('merges two objects', () => {
    const program = compileSource('.result = merge(.defaults, .overrides)!');
    const outcome = program.run(
      LogEvent.from({ defaults: { a: 1, b: 2 }, overrides: { b: 3, c: 4 } }),
    );
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('result')).toEqual(
        new Map<string, unknown>([
          ['a', 1n],
          ['b', 3n],
          ['c', 4n],
        ]),
      );
    }
  });

  it('sorts an array', () => {
    const program = compileSource('.sorted = sort(.scores)!');
    const outcome = program.run(LogEvent.from({ scores: [3, 1, 2] }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('sorted')).toEqual([1n, 2n, 3n]);
    }
  });

  it('runs map_keys with a real closure', () => {
    const program = compileSource('.out = map_keys(.h, |k, v| upcase(k) ?? k)!');
    const outcome = program.run(LogEvent.from({ h: { one: 1, two: 2 } }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('out')).toEqual(
        new Map<string, unknown>([
          ['ONE', 1n],
          ['TWO', 2n],
        ]),
      );
    }
  });
});
