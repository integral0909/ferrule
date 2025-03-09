import { LimitExceededError } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { JsonReadSyntaxError, nodeToPlain, readJsonDocument } from '@ferrule/config';

function parse(text: string): unknown {
  return nodeToPlain(readJsonDocument(text), 'test.json').value;
}

describe('readJsonDocument', () => {
  it('parses scalars and containers', () => {
    expect(parse('null')).toBeNull();
    expect(parse('true')).toBe(true);
    expect(parse('"hi"')).toBe('hi');
    expect(parse('[1, 2, 3]')).toEqual([1, 2, 3]);
    expect(parse('{"a": 1, "b": [2, 3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('keeps integers and floats distinct, like the core JSON codec', () => {
    expect(parse('1')).toBe(1);
    expect(parse('1.0')).toBe(1);
    expect(parse('1e2')).toBe(100);
  });

  it('preserves integers beyond the safe range as bigint', () => {
    expect(parse('9223372036854775807')).toBe(9_223_372_036_854_775_807n);
  });

  it('decodes string escapes', () => {
    expect(parse(String.raw`"a\nb\tA"`)).toBe('a\nb\tA');
  });

  it('records source positions for nested values', () => {
    const doc = readJsonDocument('{\n  "a": {\n    "b": 1\n  }\n}\n');
    const { positions } = nodeToPlain(doc, 'x.json');
    const loc = positions.resolve(['a', 'b']);
    expect(loc?.range.start.line).toBe(3);
  });

  it('rejects duplicate keys', () => {
    expect(() => parse('{"a": 1, "a": 2}')).toThrowError(JsonReadSyntaxError);
  });

  it('rejects trailing content and malformed input with a line/column', () => {
    try {
      parse('{"a": 1} garbage');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsonReadSyntaxError);
      expect((error as JsonReadSyntaxError).line).toBe(1);
    }
  });

  it('enforces depth and length limits', () => {
    const deep = '['.repeat(50) + ']'.repeat(50);
    expect(() => readJsonDocument(deep, { maxDepth: 10 })).toThrow(LimitExceededError);
    expect(() => readJsonDocument('{}', { maxLength: 1 })).toThrow(LimitExceededError);
  });
});
