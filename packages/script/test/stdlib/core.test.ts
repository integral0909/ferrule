import { describe, expect, it } from 'vitest';
import { createDefaultImplementations, Failure, isFailure } from '@ferrule/script';
import { args, fakeCtx } from './helpers.js';

const impls = createDefaultImplementations();

function call(name: string, positional: readonly unknown[], named?: Record<string, unknown>) {
  const fn = impls.get(name);
  if (fn === undefined) throw new Error(`no implementation registered for '${name}'`);
  const namedMap = named === undefined ? undefined : new Map(Object.entries(named));
  return fn.call(args(positional as never, namedMap as never), fakeCtx(), { start: 0, end: 0 });
}

describe('upcase/downcase', () => {
  it('converts case, including non-ASCII', () => {
    expect(call('upcase', ['café'])).toBe('CAFÉ');
    expect(call('downcase', ['CAFÉ'])).toBe('café');
  });
  it('fails on a non-string', () => {
    expect(isFailure(call('upcase', [1n]))).toBe(true);
    expect(isFailure(call('downcase', [null]))).toBe(true);
  });
});

describe('length', () => {
  it('measures strings in UTF-16 code units', () => {
    expect(call('length', ['abc'])).toBe(3n);
    // U+1F44D (👍) is a surrogate pair: 2 UTF-16 code units.
    expect(call('length', ['👍'])).toBe(2n);
  });
  it('measures bytes, arrays, and objects', () => {
    expect(call('length', [new Uint8Array([1, 2, 3])])).toBe(3n);
    expect(call('length', [[1n, 2n]])).toBe(2n);
    expect(call('length', [new Map([['a', 1n]])])).toBe(1n);
  });
  it('fails on an unsupported kind', () => {
    expect(isFailure(call('length', [true]))).toBe(true);
  });
});

describe('parse_json', () => {
  it('parses a JSON document, preserving int vs float', () => {
    const result = call('parse_json', ['{"a": 1, "b": 1.5}']) as Map<string, unknown>;
    expect(result.get('a')).toBe(1n);
    expect(result.get('b')).toBe(1.5);
  });
  it('fails on malformed JSON', () => {
    expect(isFailure(call('parse_json', ['{not json']))).toBe(true);
  });
});

// `parse_regex` (match-and-capture) and `compile_regex` (the old "pattern -> regex" constructor
// this used to be) are implemented and tested in `stdlib/parsing.ts` / `test/stdlib/parsing.test.ts`.

describe('map_values', () => {
  it('applies a closure to every field, in order', () => {
    const fn = impls.get('map_values')!;
    const closure = (a: readonly unknown[]) => (a[1] as string).toUpperCase();
    const result = fn.call(
      {
        positional: [
          new Map([
            ['a', 'x'],
            ['b', 'y'],
          ]),
        ] as never,
        named: new Map(),
        closures: [closure],
        positionalSupplied: [true],
      },
      fakeCtx(),
      { start: 0, end: 0 },
    ) as Map<string, string>;
    expect([...result]).toEqual([
      ['a', 'X'],
      ['b', 'Y'],
    ]);
  });

  it('propagates a Failure from the closure', () => {
    const fn = impls.get('map_values')!;
    const closure = () => new Failure('closure failed');
    const result = fn.call(
      {
        positional: [new Map([['a', 'x']])] as never,
        named: new Map(),
        closures: [closure],
        positionalSupplied: [true],
      },
      fakeCtx(),
      { start: 0, end: 0 },
    );
    expect(isFailure(result)).toBe(true);
  });

  it('fails on a non-object input', () => {
    expect(isFailure(call('map_values', [1n]))).toBe(true);
  });
});

describe('filter', () => {
  it('keeps elements the closure returns true for', () => {
    const fn = impls.get('filter')!;
    const closure = (a: readonly unknown[]) => typeof a[0] === 'string';
    const result = fn.call(
      {
        positional: [[1n, 'x', 2n, 'y']] as never,
        named: new Map(),
        closures: [closure],
        positionalSupplied: [true],
      },
      fakeCtx(),
      { start: 0, end: 0 },
    );
    expect(result).toEqual(['x', 'y']);
  });
});
