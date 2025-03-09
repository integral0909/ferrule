import { LimitExceededError } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { nodeToPlain, parseYamlDocument, YamlSyntaxError } from '@ferrule/config';

function parse(text: string): unknown {
  return nodeToPlain(parseYamlDocument(text), 'test.yaml').value;
}

describe('scalars', () => {
  it('resolves plain null, bool, int, float per the core schema', () => {
    expect(parse('a: null')).toEqual({ a: null });
    expect(parse('a: ~')).toEqual({ a: null });
    expect(parse('a:')).toEqual({ a: null });
    expect(parse('a: true')).toEqual({ a: true });
    expect(parse('a: True')).toEqual({ a: true });
    expect(parse('a: FALSE')).toEqual({ a: false });
    expect(parse('a: 42')).toEqual({ a: 42 });
    expect(parse('a: -17')).toEqual({ a: -17 });
    expect(parse('a: 0x1A')).toEqual({ a: 26 });
    expect(parse('a: 0o17')).toEqual({ a: 15 });
    expect(parse('a: 1.5')).toEqual({ a: 1.5 });
    expect(parse('a: 1e3')).toEqual({ a: 1000 });
    expect(parse('a: .inf')).toEqual({ a: Infinity });
    expect(parse('a: -.inf')).toEqual({ a: -Infinity });
    expect((parse('a: .nan') as { a: number }).a).toBeNaN();
  });

  it('keeps large integers as bigint and small ones as number', () => {
    expect(parse('a: 9223372036854775807')).toEqual({ a: 9_223_372_036_854_775_807n });
    expect(parse('a: 9007199254740991')).toEqual({ a: 9_007_199_254_740_991 });
  });

  it('treats the Norway-problem words as plain strings under the core schema', () => {
    expect(parse('a: no')).toEqual({ a: 'no' });
    expect(parse('a: yes')).toEqual({ a: 'yes' });
    expect(parse('a: on')).toEqual({ a: 'on' });
    expect(parse('a: off')).toEqual({ a: 'off' });
  });

  it('rejects leading zeros as neither int nor float, keeping them a string', () => {
    expect(parse('a: 0123')).toEqual({ a: '0123' });
  });

  it('parses single- and double-quoted scalars, always as strings', () => {
    expect(parse("a: 'hello'")).toEqual({ a: 'hello' });
    expect(parse("a: 'it''s'")).toEqual({ a: "it's" });
    expect(parse('a: "42"')).toEqual({ a: '42' });
    expect(parse('a: "true"')).toEqual({ a: 'true' });
    expect(parse(String.raw`a: "line\nbreak"`)).toEqual({ a: 'line\nbreak' });
    expect(parse(String.raw`a: "tab\there"`)).toEqual({ a: 'tab\there' });
    expect(parse(String.raw`a: "\x41\u0042\U00000043"`)).toEqual({ a: 'ABC' });
    expect(parse(String.raw`a: "quote\"inside"`)).toEqual({ a: 'quote"inside' });
  });

  it('trims plain scalars and strips trailing comments', () => {
    expect(parse('a: hello world   # a comment')).toEqual({ a: 'hello world' });
    expect(parse('a: "not # a comment"')).toEqual({ a: 'not # a comment' });
  });
});

describe('block mappings', () => {
  it('parses nested mappings', () => {
    expect(parse('a:\n  b: 1\n  c: 2\n')).toEqual({ a: { b: 1, c: 2 } });
  });

  it('parses mappings with mixed indentation styles across siblings', () => {
    const text = 'a:\n    b: 1\nc: 2\n';
    expect(parse(text)).toEqual({ a: { b: 1 }, c: 2 });
  });

  it('supports quoted keys', () => {
    expect(parse('"a b": 1\n\'c\': 2\n')).toEqual({ 'a b': 1, c: 2 });
  });

  it('rejects duplicate keys with both locations noted', () => {
    expect(() => parse('a: 1\na: 2\n')).toThrowError(YamlSyntaxError);
    try {
      parse('a: 1\na: 2\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(YamlSyntaxError);
      expect((error as YamlSyntaxError).message).toContain('duplicate key');
      expect((error as YamlSyntaxError).line).toBe(2);
    }
  });

  it('reports an unknown-key-like structural error with a line and column', () => {
    try {
      parse('a: 1\n  b: 2\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(YamlSyntaxError);
    }
  });
});

describe('block sequences', () => {
  it('parses simple sequences', () => {
    expect(parse('a:\n  - 1\n  - 2\n  - 3\n')).toEqual({ a: [1, 2, 3] });
  });

  it('parses a sequence of mappings using the compact "- key: value" form', () => {
    const text = 'items:\n  - name: a\n    value: 1\n  - name: b\n    value: 2\n';
    expect(parse(text)).toEqual({
      items: [
        { name: 'a', value: 1 },
        { name: 'b', value: 2 },
      ],
    });
  });

  it('parses top-level sequences', () => {
    expect(parse('- 1\n- 2\n')).toEqual([1, 2]);
  });

  it('parses nested compact sequences', () => {
    expect(parse('- - 1\n  - 2\n- 3\n')).toEqual([[1, 2], 3]);
  });

  it('treats a dash-prefixed scalar like "-5" as a plain scalar, not a sequence', () => {
    expect(parse('a: -5\n')).toEqual({ a: -5 });
  });
});

describe('flow collections', () => {
  it('parses flow sequences and mappings', () => {
    expect(parse('a: [1, 2, 3]')).toEqual({ a: [1, 2, 3] });
    expect(parse('a: {b: 1, c: 2}')).toEqual({ a: { b: 1, c: 2 } });
  });

  it('parses empty flow collections', () => {
    expect(parse('a: []')).toEqual({ a: [] });
    expect(parse('a: {}')).toEqual({ a: {} });
  });

  it('parses nested flow collections spanning multiple lines with comments', () => {
    const text = 'a: [\n  1, # one\n  2,\n  {b: 3},\n]\n';
    expect(parse(text)).toEqual({ a: [1, 2, { b: 3 }] });
  });

  it('supports the flow-mapping key-only shorthand', () => {
    expect(parse('a: {b, c: 1}')).toEqual({ a: { b: null, c: 1 } });
  });

  it('rejects duplicate keys inside a flow mapping', () => {
    expect(() => parse('a: {b: 1, b: 2}')).toThrowError(YamlSyntaxError);
  });
});

describe('comments and blank lines', () => {
  it('ignores full-line and trailing comments', () => {
    const text = '# leading comment\na: 1 # trailing\n\n# another\nb: 2\n';
    expect(parse(text)).toEqual({ a: 1, b: 2 });
  });
});

describe('block scalars', () => {
  it('parses a literal block scalar with default (clip) chomping', () => {
    expect(parse('a: |\n  line one\n  line two\n')).toEqual({ a: 'line one\nline two\n' });
  });

  it('parses a folded block scalar, joining single line breaks with spaces', () => {
    expect(parse('a: >\n  line one\n  line two\n')).toEqual({ a: 'line one line two\n' });
  });

  it('preserves blank lines within a folded scalar', () => {
    expect(parse('a: >\n  line one\n\n  line two\n')).toEqual({ a: 'line one\nline two\n' });
  });

  it('strips the trailing newline with "-" chomping', () => {
    expect(parse('a: |-\n  line one\n  line two\n')).toEqual({ a: 'line one\nline two' });
  });

  it('keeps trailing blank lines with "+" chomping', () => {
    expect(parse('a: |+\n  line one\n\n\n')).toEqual({ a: 'line one\n\n\n' });
  });

  it('honours an explicit indentation indicator', () => {
    expect(parse('a: |2\n    indented once more\n  back\n')).toEqual({
      a: '  indented once more\nback\n',
    });
  });

  it('produces an empty string for a block scalar with no content', () => {
    expect(parse('a: |\nb: 2\n')).toEqual({ a: '', b: 2 });
  });

  it('does not resolve block scalar content through the core schema', () => {
    expect(parse('a: |\n  true\n')).toEqual({ a: 'true\n' });
  });

  it("rejects tabs within a block scalar's indentation prefix", () => {
    expect(() => parse('a: |\n\tindented with a tab\n')).toThrowError(YamlSyntaxError);
  });
});

describe('anchors, aliases, and merge keys', () => {
  it('resolves a simple alias to the same value', () => {
    expect(parse('a: &x 1\nb: *x\n')).toEqual({ a: 1, b: 1 });
  });

  it('resolves aliases to collections', () => {
    const text = 'defaults: &d\n  x: 1\n  y: 2\nover:\n  <<: *d\n  y: 3\n';
    expect(parse(text)).toEqual({ defaults: { x: 1, y: 2 }, over: { x: 1, y: 3 } });
  });

  it('lets explicit keys win over merged keys, and earlier merge sources win over later ones', () => {
    const text = [
      'a: &a\n  k: 1\n',
      'b: &b\n  k: 2\n  j: 2\n',
      'c:\n  <<: [*a, *b]\n  k: 9\n',
    ].join('');
    expect(parse(text)).toEqual({
      a: { k: 1 },
      b: { k: 2, j: 2 },
      c: { k: 9, j: 2 },
    });
  });

  it('fails on an unknown anchor', () => {
    expect(() => parse('a: *missing\n')).toThrowError(YamlSyntaxError);
  });

  it('rejects a merge value that is not a mapping or a sequence of mappings', () => {
    expect(() => parse('a:\n  <<: 1\n')).toThrowError(YamlSyntaxError);
  });
});

describe('explicit tags', () => {
  it('applies !!str, !!int, !!float, !!bool, and !!null', () => {
    expect(parse('a: !!str 123')).toEqual({ a: '123' });
    expect(parse('a: !!int "42"')).toEqual({ a: 42 });
    expect(parse('a: !!float "1"')).toEqual({ a: 1 });
    expect(parse('a: !!bool "true"')).toEqual({ a: true });
    expect(parse('a: !!null ""')).toEqual({ a: null });
  });

  it('rejects invalid values for an explicit tag', () => {
    expect(() => parse('a: !!int not-a-number')).toThrowError(YamlSyntaxError);
  });

  it('rejects unsupported tags', () => {
    expect(() => parse('a: !!timestamp 2020-01-01')).toThrowError(YamlSyntaxError);
    expect(() => parse('a: !mytag foo')).toThrowError(YamlSyntaxError);
  });

  it('rejects a tag applied to a collection', () => {
    expect(() => parse('a: !!str\n  b: 1\n')).toThrowError(YamlSyntaxError);
  });
});

describe('document markers', () => {
  it('accepts a leading "---" document start marker', () => {
    expect(parse('---\na: 1\n')).toEqual({ a: 1 });
  });

  it('accepts a trailing "..." document end marker', () => {
    expect(parse('a: 1\n...\n')).toEqual({ a: 1 });
  });

  it('rejects a second document', () => {
    expect(() => parse('a: 1\n---\nb: 2\n')).toThrowError(/multiple/);
  });

  it('rejects YAML directives', () => {
    expect(() => parse('%YAML 1.2\n---\na: 1\n')).toThrowError(YamlSyntaxError);
  });
});

describe('errors have precise line and column information', () => {
  it('reports the line and column of a tab-in-indentation error', () => {
    try {
      parse('a:\n\tb: 1\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(YamlSyntaxError);
      const e = error as YamlSyntaxError;
      expect(e.line).toBe(2);
      expect(e.column).toBe(1);
      expect(e.code).toBe('E_YAML_TAB_INDENT');
    }
  });

  it('reports the line and column of an unterminated quoted scalar', () => {
    try {
      parse('a: "unterminated\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(YamlSyntaxError);
      expect((error as YamlSyntaxError).line).toBe(1);
    }
  });
});

describe('limits', () => {
  it('rejects documents deeper than maxDepth', () => {
    const deep = '- '.repeat(500) + '1\n';
    expect(() => parseYamlDocument(deep, { maxDepth: 50 })).toThrow(LimitExceededError);
  });

  it('rejects input longer than maxLength', () => {
    expect(() => parseYamlDocument('a: 1\n', { maxLength: 2 })).toThrow(LimitExceededError);
  });

  it('rejects an alias bomb via the alias-expansion budget', () => {
    const lines: string[] = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i <= 10; i++) {
      lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]`);
    }
    const text = lines.join('\n') + '\n';
    expect(() => parseYamlDocument(text, { maxAliasExpansion: 1000 })).toThrow(LimitExceededError);
  });

  it('rejects a document defining too many anchors', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `k${i}: &a${i} ${i}`);
    expect(() => parseYamlDocument(lines.join('\n') + '\n', { maxAnchors: 5 })).toThrow(
      LimitExceededError,
    );
  });
});

describe('JSON compatibility subset', () => {
  it('parses JSON-flavoured flow YAML', () => {
    expect(parse('{"a": [1, 2, {"b": true, "c": null}]}')).toEqual({
      a: [1, 2, { b: true, c: null }],
    });
  });
});
