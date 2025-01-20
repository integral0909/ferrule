import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cloneValue,
  compareValues,
  estimateSize,
  formatFloat,
  formatValue,
  fromPlain,
  INT64_MAX,
  INT64_MIN,
  isInt64,
  kindOf,
  LimitExceededError,
  objectOf,
  Timestamp,
  toPlain,
  valuesEqual,
  ValueTypeError,
  wrapInt64,
  type Value,
} from '@ferrule/core';
import { arbValue } from './arbitraries.js';

describe('kindOf', () => {
  it('classifies every kind', () => {
    expect(kindOf(null)).toBe('null');
    expect(kindOf(true)).toBe('boolean');
    expect(kindOf(1n)).toBe('integer');
    expect(kindOf(1)).toBe('float');
    expect(kindOf('x')).toBe('string');
    expect(kindOf(new Uint8Array(1))).toBe('bytes');
    expect(kindOf(Timestamp.fromMillis(0))).toBe('timestamp');
    expect(kindOf([])).toBe('array');
    expect(kindOf(new Map())).toBe('object');
  });
});

describe('int64 helpers', () => {
  it('checks and wraps the int64 range', () => {
    expect(isInt64(INT64_MAX)).toBe(true);
    expect(isInt64(INT64_MAX + 1n)).toBe(false);
    expect(isInt64(INT64_MIN - 1n)).toBe(false);
    expect(wrapInt64(INT64_MAX + 1n)).toBe(INT64_MIN);
    expect(wrapInt64(INT64_MIN - 1n)).toBe(INT64_MAX);
  });
});

describe('valuesEqual', () => {
  it('distinguishes integers from floats', () => {
    expect(valuesEqual(1n, 1)).toBe(false);
    expect(valuesEqual(1n, 1n)).toBe(true);
  });

  it('treats NaN as equal to itself and signed zeros as equal', () => {
    expect(valuesEqual(NaN, NaN)).toBe(true);
    expect(valuesEqual(0, -0)).toBe(true);
  });

  it('compares nested structures independent of key order', () => {
    const a = objectOf({ x: [1, 'a', { y: null }], z: true });
    const b = new Map<string, Value>([
      ['z', true],
      ['x', [1n, 'a', new Map([['y', null]])]],
    ]);
    expect(valuesEqual(a, b)).toBe(true);
    b.set('extra', 1n);
    expect(valuesEqual(a, b)).toBe(false);
  });

  it('compares bytes and timestamps by content', () => {
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(valuesEqual(Timestamp.fromMillis(5), Timestamp.fromMillis(5))).toBe(true);
    expect(valuesEqual(Timestamp.fromMillis(5), new Uint8Array())).toBe(false);
    expect(valuesEqual([], new Map())).toBe(false);
  });

  it('holds for any value and its clone', () => {
    fc.assert(
      fc.property(arbValue, (v) => {
        expect(valuesEqual(v, cloneValue(v))).toBe(true);
      }),
    );
  });
});

describe('compareValues', () => {
  it('orders kinds', () => {
    const ordered: Value[] = [
      null,
      false,
      true,
      -1n,
      0.5,
      1n,
      'a',
      new Uint8Array([0]),
      Timestamp.fromMillis(0),
      [],
      new Map(),
    ];
    const shuffled = [...ordered].reverse();
    shuffled.sort(compareValues);
    expect(shuffled).toEqual(ordered);
  });

  it('compares integers and floats numerically, integer first on ties, NaN last', () => {
    expect(compareValues(1n, 1.5)).toBe(-1);
    expect(compareValues(2n, 1.5)).toBe(1);
    expect(compareValues(1n, 1)).toBe(-1);
    expect(compareValues(1, 1n)).toBe(1);
    expect(compareValues(NaN, 10n ** 18n)).toBe(1);
    expect(compareValues(NaN, NaN)).toBe(0);
    expect(compareValues(-Infinity, NaN)).toBe(-1);
  });

  it('compares arrays lexicographically and objects by sorted entries', () => {
    expect(compareValues([1n, 2n], [1n, 3n])).toBe(-1);
    expect(compareValues([1n], [1n, 0n])).toBe(-1);
    expect(compareValues(objectOf({ b: 1, a: 2 }), objectOf({ a: 2, b: 1 }))).toBe(0);
    expect(compareValues(objectOf({ a: 1 }), objectOf({ b: 1 }))).toBe(-1);
    expect(compareValues(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(-1);
  });

  it('is a consistent total order', () => {
    fc.assert(
      fc.property(arbValue, arbValue, arbValue, (a, b, c) => {
        expect(compareValues(a, a)).toBe(0);
        expect(compareValues(a, b)).toBe(-compareValues(b, a) || 0);
        if (compareValues(a, b) <= 0 && compareValues(b, c) <= 0) {
          expect(compareValues(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('cloneValue', () => {
  it('produces an independent deep copy', () => {
    const original = objectOf({ list: [1, { deep: 'x' }], bytes: new Uint8Array([1]) });
    const copy = cloneValue(original);
    ((copy.get('list') as Value[])[1] as Map<string, Value>).set('deep', 'changed');
    (copy.get('bytes') as Uint8Array)[0] = 9;
    expect(formatValue(original)).toBe('{ "list": [1, { "deep": "x" }], "bytes": b"\\x01" }');
  });
});

describe('fromPlain / toPlain', () => {
  it('converts plain data, keeping integers distinct from floats', () => {
    const v = fromPlain({ a: 1, b: 1.5, c: [true, null, 'x'], d: undefined, e: new Date(0) });
    expect(v).toEqual(
      new Map<string, Value>([
        ['a', 1n],
        ['b', 1.5],
        ['c', [true, null, 'x']],
        ['e', Timestamp.fromMillis(0)],
      ]),
    );
  });

  it('can keep all numbers as floats', () => {
    expect(fromPlain(3, { numbers: 'float' })).toBe(3);
    expect(fromPlain(-0)).toBe(-0);
    expect(fromPlain(2 ** 60)).toBe(2 ** 60);
  });

  it('treats __proto__ as an ordinary key in both directions', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const v = fromPlain(parsed) as Map<string, Value>;
    expect(v.has('__proto__')).toBe(true);
    const plain = toPlain(v) as Record<string, unknown>;
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(Object.hasOwn(plain, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('converts binary data and maps', () => {
    expect(fromPlain(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    expect(fromPlain(new Uint8Array([7]).buffer)).toEqual(new Uint8Array([7]));
    expect(fromPlain(new Map([['k', 1]]))).toEqual(new Map([['k', 1n]]));
  });

  it('rejects unsupported inputs', () => {
    expect(() => fromPlain(() => 1)).toThrow(ValueTypeError);
    expect(() => fromPlain(Symbol('x'))).toThrow(ValueTypeError);
    expect(() => fromPlain(new Int16Array(2))).toThrow(ValueTypeError);
    expect(() => fromPlain(new Map([[1, 1]]))).toThrow(ValueTypeError);
    expect(() => fromPlain(2n ** 64n)).toThrow(ValueTypeError);
  });

  it('bounds nesting depth, including cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => fromPlain(cyclic)).toThrow(LimitExceededError);
    expect(() => fromPlain([[[1]]], { maxDepth: 2 })).toThrow(LimitExceededError);
  });

  it('renders integers, bytes, and timestamps as requested', () => {
    const v = objectOf({ n: 5, b: new Uint8Array([104, 105]), t: new Date(0) });
    expect(toPlain(v, { integers: 'number', bytes: 'base64', timestamps: 'string' })).toEqual({
      n: 5,
      b: 'aGk=',
      t: '1970-01-01T00:00:00Z',
    });
    expect(toPlain(v, { integers: 'string', timestamps: 'date' })).toEqual({
      n: '5',
      b: new Uint8Array([104, 105]),
      t: new Date(0),
    });
  });
});

describe('estimateSize', () => {
  it('grows with content', () => {
    expect(estimateSize('abcd')).toBeGreaterThan(estimateSize('a'));
    expect(estimateSize(objectOf({ a: [1, 2, 3] }))).toBeGreaterThan(
      estimateSize(objectOf({ a: [1] })),
    );
    expect(estimateSize(null)).toBe(1);
    expect(estimateSize(new Uint8Array(100))).toBe(108);
  });
});

describe('formatValue', () => {
  it('uses Ferrule literal syntax', () => {
    expect(formatValue(1n)).toBe('1');
    expect(formatValue(1)).toBe('1.0');
    expect(formatValue('a"b')).toBe('"a\\"b"');
    expect(formatValue(Timestamp.fromMillis(0))).toBe("t'1970-01-01T00:00:00Z'");
    expect(formatValue(new Uint8Array([0x61, 0x00, 0x22]))).toBe('b"a\\x00\\x22"');
    expect(formatValue(new Map())).toBe('{}');
    expect(formatValue([null, true])).toBe('[null, true]');
  });

  it('truncates long output', () => {
    expect(formatValue('x'.repeat(100), 10)).toHaveLength(10);
    expect(formatValue('x'.repeat(100), 10).endsWith('…')).toBe(true);
  });

  it('marks floats unambiguously', () => {
    expect(formatFloat(-0)).toBe('-0.0');
    expect(formatFloat(1e21)).toBe('1e+21');
    expect(formatFloat(0.5)).toBe('0.5');
    expect(formatFloat(NaN)).toBe('NaN');
    expect(formatFloat(-Infinity)).toBe('-Infinity');
  });
});
