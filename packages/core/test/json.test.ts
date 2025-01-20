import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  encodeJson,
  FerruleError,
  fromPlain,
  JsonSyntaxError,
  LimitExceededError,
  objectOf,
  parseJson,
  Timestamp,
  tryParseJson,
  valuesEqual,
  type Value,
} from '@ferrule/core';
import { arbJsonValue } from './arbitraries.js';

describe('parseJson', () => {
  it('parses scalars', () => {
    expect(parseJson('null')).toBeNull();
    expect(parseJson('true')).toBe(true);
    expect(parseJson('false')).toBe(false);
    expect(parseJson('"hi"')).toBe('hi');
    expect(parseJson('  42  ')).toBe(42n);
  });

  it('keeps integers and floats distinct', () => {
    expect(parseJson('1')).toBe(1n);
    expect(parseJson('1.0')).toBe(1);
    expect(parseJson('1e2')).toBe(100);
    expect(parseJson('-0')).toBe(0n);
    expect(parseJson('-0.0')).toBe(-0);
  });

  it('preserves integers beyond 2^53 and falls back to float beyond int64', () => {
    expect(parseJson('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(parseJson('9223372036854775807')).toBe(9_223_372_036_854_775_807n);
    expect(parseJson('-9223372036854775808')).toBe(-9_223_372_036_854_775_808n);
    expect(parseJson('9223372036854775808')).toBe(9_223_372_036_854_775_808);
  });

  it('parses nested structures in key order', () => {
    const v = parseJson('{"b": [1, {"c": null}], "a": "x", "1": true}') as Map<string, Value>;
    expect([...v.keys()]).toEqual(['b', 'a', '1']);
    expect(valuesEqual(v, objectOf({ b: [1, { c: null }], a: 'x', 1: true }))).toBe(true);
  });

  it('decodes escapes, including surrogate pairs', () => {
    expect(parseJson(String.raw`"a\"b\\c\/d\b\f\n\r\t"`)).toBe('a"b\\c/d\b\f\n\r\t');
    expect(parseJson('"\\u00e9\\ud83d\\ude00"')).toBe('\u00e9\u{1f600}');
    expect(parseJson(String.raw`"plain then \n escape"`)).toBe('plain then \n escape');
  });

  it('handles duplicate keys per policy', () => {
    const text = '{"k": 1, "k": 2}';
    expect((parseJson(text) as Map<string, Value>).get('k')).toBe(2n);
    expect((parseJson(text, { duplicateKeys: 'first' }) as Map<string, Value>).get('k')).toBe(1n);
    expect(() => parseJson(text, { duplicateKeys: 'error' })).toThrow(/duplicate key "k"/);
  });

  it('keeps __proto__ as data', () => {
    const v = parseJson('{"__proto__": {"x": 1}}') as Map<string, Value>;
    expect(v.get('__proto__')).toEqual(new Map([['x', 1n]]));
  });

  it.each([
    ['', 'unexpected end of input'],
    ['{', 'expected a string key'],
    ['{"a" 1}', 'expected ":"'],
    ['{"a": 1,}', 'expected a string key'],
    ['[1,]', 'unexpected character'],
    ['[1 2]', 'expected "," or "]"'],
    ['01', 'leading zeros'],
    ['1.', 'unexpected trailing content'],
    ['-', 'invalid number'],
    ['tru', 'invalid literal'],
    ['"abc', 'unterminated string'],
    ['"a\\x"', 'invalid escape'],
    ['"\\u12"', 'invalid unicode escape'],
    ['"tab\there"', 'unescaped control character'],
    ['{"a":1} x', 'unexpected trailing content'],
    ['NaN', 'unexpected character'],
  ])('rejects %j (%s)', (text, message) => {
    expect(() => parseJson(text)).toThrow(JsonSyntaxError);
    expect(() => parseJson(text)).toThrow(message);
  });

  it('reports line and column', () => {
    try {
      parseJson('{\n  "a": 1,\n  "b": ?\n}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsonSyntaxError);
      expect((error as JsonSyntaxError).line).toBe(3);
      expect((error as JsonSyntaxError).column).toBe(8);
    }
  });

  it('enforces depth and length limits', () => {
    const deep = '['.repeat(200) + ']'.repeat(200);
    expect(() => parseJson(deep)).toThrow(LimitExceededError);
    expect(parseJson('[[[]]]', { maxDepth: 3 })).toEqual([[[]]]);
    expect(() => parseJson('[[[[]]]]', { maxDepth: 3 })).toThrow(LimitExceededError);
    expect(() => parseJson('"abcdef"', { maxLength: 4 })).toThrow(LimitExceededError);
  });

  it('agrees with JSON.parse on structure for arbitrary documents', () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        const expected = fromPlain(JSON.parse(text) as unknown, { numbers: 'float' });
        const actual = parseJson(text);
        expect(valuesEqual(normaliseNumbers(actual), expected)).toBe(true);
      }),
    );
  });

  it('never throws anything but Ferrule errors on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const result = tryParseJson(text);
        if (!result.ok) expect(result.error).toBeInstanceOf(FerruleError);
      }),
    );
  });
});

describe('encodeJson', () => {
  it('encodes every kind', () => {
    const v = objectOf({
      i: 1,
      f: 1.5,
      whole: 2.0,
      s: 'q"',
      b: new Uint8Array([1, 2, 3]),
      t: Timestamp.fromMillis(0),
      n: null,
      a: [true, false],
      o: {},
    });
    // `objectOf` turns 2.0 into an integer (it is a safe integer in JS), so set the float explicitly.
    v.set('whole', 2);
    expect(encodeJson(v)).toBe(
      '{"i":1,"f":1.5,"whole":2.0,"s":"q\\"","b":"AQID","t":"1970-01-01T00:00:00Z","n":null,"a":[true,false],"o":{}}',
    );
  });

  it('writes plain floats when asked', () => {
    expect(encodeJson(2, { floats: 'plain' })).toBe('2');
    expect(encodeJson(2)).toBe('2.0');
  });

  it('encodes large integers exactly', () => {
    expect(encodeJson(9_223_372_036_854_775_807n)).toBe('9223372036854775807');
  });

  it('handles non-finite floats per policy', () => {
    expect(encodeJson([NaN, Infinity])).toBe('[null,null]');
    expect(encodeJson(NaN, { nonFinite: 'string' })).toBe('"NaN"');
    expect(() => encodeJson(-Infinity, { nonFinite: 'error' })).toThrow(FerruleError);
  });

  it('pretty-prints and sorts keys', () => {
    const v = objectOf({ b: [1], a: {} });
    expect(encodeJson(v, { indent: 2, sortKeys: true })).toBe(
      '{\n  "a": {},\n  "b": [\n    1\n  ]\n}',
    );
  });

  it('bounds depth, catching cyclic values', () => {
    const list: Value[] = [];
    list.push(list);
    expect(() => encodeJson(list)).toThrow(LimitExceededError);
  });

  it('round-trips with parseJson without losing type information', () => {
    fc.assert(
      fc.property(arbJsonValue, (v) => {
        expect(valuesEqual(parseJson(encodeJson(v)), v)).toBe(true);
        expect(valuesEqual(parseJson(encodeJson(v, { indent: 2 })), v)).toBe(true);
      }),
    );
  });
});

/** Converts every integer to a float so results can be compared with JSON.parse output. */
function normaliseNumbers(v: Value): Value {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(normaliseNumbers);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, normaliseNumbers(x)]));
  return v;
}
