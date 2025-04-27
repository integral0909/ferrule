import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { lex, SourceFile, type Token, type TokenKind } from '@ferrule/script';

function kinds(text: string): TokenKind[] {
  const { tokens } = lex(new SourceFile('<test>', text));
  return tokens.map((t) => t.token.kind);
}

function tokenAt(text: string, index: number): Token {
  const { tokens } = lex(new SourceFile('<test>', text));
  return tokens[index]!.token;
}

describe('lexer: identifiers and keywords', () => {
  it('lexes identifiers', () => {
    expect(kinds('status _tmp http_code2')).toEqual([
      'identifier',
      'identifier',
      'identifier',
      'eof',
    ]);
  });

  it('lexes keywords distinctly from identifiers', () => {
    expect(kinds('let mut if else match true false null drop abort test given expect is')).toEqual([
      'let',
      'mut',
      'if',
      'else',
      'match',
      'true',
      'false',
      'null',
      'drop',
      'abort',
      'test',
      'given',
      'expect',
      'is',
      'eof',
    ]);
  });

  it('does not confuse a keyword-prefixed identifier for a keyword', () => {
    expect(kinds('lettuce iffy matches')).toEqual([
      'identifier',
      'identifier',
      'identifier',
      'eof',
    ]);
  });

  it('lexes the wildcard underscore', () => {
    expect(kinds('_')).toEqual(['_', 'eof']);
  });
});

describe('lexer: numbers', () => {
  it('lexes decimal integers with underscores', () => {
    const t = tokenAt('1_000_000', 0);
    expect(t.kind).toBe('int');
    if (t.kind === 'int') expect(t.value).toBe(1_000_000n);
  });

  it('lexes hex integers', () => {
    const t = tokenAt('0x1F', 0);
    expect(t.kind).toBe('int');
    if (t.kind === 'int') expect(t.value).toBe(31n);
  });

  it('lexes binary integers', () => {
    const t = tokenAt('0b1010', 0);
    expect(t.kind).toBe('int');
    if (t.kind === 'int') expect(t.value).toBe(10n);
  });

  it('flags an out-of-range integer literal', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '99999999999999999999999'));
    expect(diagnostics.some((d) => d.code === 'E005')).toBe(true);
  });

  it('accepts int64::MIN magnitude at the lexer level (parser resolves the sign)', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '9223372036854775808'));
    expect(diagnostics.some((d) => d.code === 'E005')).toBe(false);
  });

  it('lexes floats', () => {
    for (const [text, value] of [
      ['3.14', 3.14],
      ['1e-3', 1e-3],
      ['2.0', 2.0],
      ['2E10', 2e10],
    ] as const) {
      const t = tokenAt(text, 0);
      expect(t.kind).toBe('float');
      if (t.kind === 'float') expect(t.value).toBeCloseTo(value);
    }
  });

  it('does not treat a trailing dot as a float', () => {
    expect(kinds('1.foo')).toEqual(['int', '.', 'identifier', 'eof']);
  });

  it('reports malformed hex/binary literals', () => {
    const { diagnostics: hex } = lex(new SourceFile('<test>', '0x'));
    expect(hex.some((d) => d.code === 'E004')).toBe(true);
    const { diagnostics: bin } = lex(new SourceFile('<test>', '0b'));
    expect(bin.some((d) => d.code === 'E004')).toBe(true);
  });
});

describe('lexer: strings', () => {
  it('lexes a plain string', () => {
    const t = tokenAt('"hello"', 0);
    expect(t.kind).toBe('string');
    if (t.kind === 'string') expect(t.parts).toEqual([{ kind: 'text', value: 'hello' }]);
  });

  it('decodes escapes', () => {
    const t = tokenAt(String.raw`"a\nb\tc\\d\"e"`, 0);
    if (t.kind === 'string') expect(t.parts).toEqual([{ kind: 'text', value: 'a\nb\tc\\d"e' }]);
  });

  it('decodes \\xHH and \\u{...} escapes', () => {
    const t = tokenAt(String.raw`"\x41\u{1F600}"`, 0);
    if (t.kind === 'string') {
      expect(t.parts).toEqual([{ kind: 'text', value: `A${String.fromCodePoint(0x1f600)}` }]);
    }
  });

  it('flags an invalid escape but keeps lexing', () => {
    const { tokens, diagnostics } = lex(new SourceFile('<test>', String.raw`"a\qb"`));
    expect(diagnostics.some((d) => d.code === 'E002')).toBe(true);
    expect(tokens[0]!.token.kind).toBe('string');
  });

  it('flags an unterminated string', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '"abc'));
    expect(diagnostics.some((d) => d.code === 'E001')).toBe(true);
  });

  it('parses interpolation parts', () => {
    const t = tokenAt('"hello {{ name }}!"', 0);
    expect(t.kind).toBe('string');
    if (t.kind === 'string') {
      expect(t.parts).toHaveLength(3);
      expect(t.parts[0]).toEqual({ kind: 'text', value: 'hello ' });
      expect(t.parts[1]!.kind).toBe('interpolation');
      expect(t.parts[2]).toEqual({ kind: 'text', value: '!' });
    }
  });

  it('balances nested braces inside interpolation', () => {
    const t = tokenAt('"{{ {"a": 1}.a }}"', 0);
    expect(t.kind).toBe('string');
    if (t.kind === 'string' && t.parts[0]!.kind === 'interpolation') {
      const span = t.parts[0]!.span;
      expect('<test>'.length).toBeGreaterThanOrEqual(0);
      const text = '"{{ {"a": 1}.a }}"'.slice(span.start, span.end);
      expect(text.trim()).toBe('{"a": 1}.a');
    }
  });

  it('flags an unterminated interpolation', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '"{{ x "'));
    expect(diagnostics.some((d) => d.code === 'E003')).toBe(true);
  });
});

describe('lexer: raw, byte, timestamp, regex literals', () => {
  it('lexes a raw string with no escape processing', () => {
    const t = tokenAt(String.raw`r'no \escapes here'`, 0);
    expect(t.kind).toBe('rawString');
    if (t.kind === 'rawString') expect(t.value).toBe('no \\escapes here');
  });

  it('flags an unterminated raw string', () => {
    const { diagnostics } = lex(new SourceFile('<test>', "r'abc"));
    expect(diagnostics.some((d) => d.code === 'E006')).toBe(true);
  });

  it('lexes a byte string', () => {
    const t = tokenAt('b"\\x00\\xff"', 0);
    expect(t.kind).toBe('byteString');
    if (t.kind === 'byteString') expect([...t.value]).toEqual([0x00, 0xff]);
  });

  it('flags an unterminated byte string', () => {
    const { diagnostics } = lex(new SourceFile('<test>', 'b"abc'));
    expect(diagnostics.some((d) => d.code === 'E007')).toBe(true);
  });

  it('lexes a timestamp literal', () => {
    const t = tokenAt("t'2026-01-01T00:00:00Z'", 0);
    expect(t.kind).toBe('timestamp');
    if (t.kind === 'timestamp') expect(t.value).toBe('2026-01-01T00:00:00Z');
  });

  it('flags an unterminated timestamp literal', () => {
    const { diagnostics } = lex(new SourceFile('<test>', "t'2026-01-01"));
    expect(diagnostics.some((d) => d.code === 'E008')).toBe(true);
  });

  it('flags an invalid timestamp literal', () => {
    const { diagnostics } = lex(new SourceFile('<test>', "t'not-a-date'"));
    expect(diagnostics.some((d) => d.code === 'E009')).toBe(true);
  });

  it('lexes a regex literal with flags', () => {
    const t = tokenAt('r/^\\d+$/i', 0);
    expect(t.kind).toBe('regex');
    if (t.kind === 'regex') {
      expect(t.pattern).toBe('^\\d+$');
      expect(t.flags).toBe('i');
    }
  });

  it('flags an unterminated regex literal', () => {
    const { diagnostics } = lex(new SourceFile('<test>', 'r/abc'));
    expect(diagnostics.some((d) => d.code === 'E010')).toBe(true);
  });

  it('does not terminate a regex on a slash inside a character class', () => {
    const t = tokenAt('r/[a\\/b]/', 0);
    if (t.kind === 'regex') expect(t.pattern).toBe('[a\\/b]');
  });

  it('rejects disallowed regex flags', () => {
    const { diagnostics } = lex(new SourceFile('<test>', 'r/abc/x'));
    expect(diagnostics.some((d) => d.code === 'E011')).toBe(true);
  });

  it('rejects a repeated regex flag', () => {
    const { diagnostics } = lex(new SourceFile('<test>', 'r/abc/ii'));
    expect(diagnostics.some((d) => d.code === 'E011')).toBe(true);
  });

  it('rejects an invalid regex pattern', () => {
    const { diagnostics } = lex(new SourceFile('<test>', 'r/(/'));
    expect(diagnostics.some((d) => d.code === 'E012')).toBe(true);
  });

  it('does not mistake a plain identifier starting with r/b/t for a literal prefix', () => {
    expect(kinds('rest bay test_var')).toEqual(['identifier', 'identifier', 'identifier', 'eof']);
  });
});

describe('lexer: paths and metadata paths', () => {
  it('lexes the root path', () => {
    const t = tokenAt('.', 0);
    expect(t.kind).toBe('path');
    if (t.kind === 'path') expect(t.segments).toEqual([]);
  });

  it('lexes a compound path', () => {
    const t = tokenAt('.a.b[0]."quoted key"', 0);
    expect(t.kind).toBe('path');
    if (t.kind === 'path') expect(t.segments).toEqual(['a', 'b', 0, 'quoted key']);
  });

  it('lexes negative indices', () => {
    const t = tokenAt('.items[-1]', 0);
    if (t.kind === 'path') expect(t.segments).toEqual(['items', -1]);
  });

  it('lexes a quoted key as the very first path segment', () => {
    const t = tokenAt('."quoted"', 0);
    expect(t.kind).toBe('path');
    if (t.kind === 'path') expect(t.segments).toEqual(['quoted']);
  });

  it('lexes a metadata path', () => {
    const t = tokenAt('%source_id', 0);
    expect(t.kind).toBe('metadataPath');
    if (t.kind === 'metadataPath') expect(t.name).toBe('source_id');
  });

  it('flags a malformed path index', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '.a[x]'));
    expect(diagnostics.some((d) => d.code === 'E014')).toBe(true);
  });

  it('flags an unterminated quoted path segment', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '."unterminated'));
    expect(diagnostics.some((d) => d.code === 'E014')).toBe(true);
  });

  it('flags a path index missing its closing bracket', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '.a[0'));
    expect(diagnostics.some((d) => d.code === 'E014')).toBe(true);
  });

  it('flags a metadata path with no name', () => {
    const { diagnostics } = lex(new SourceFile('<test>', '% '));
    expect(diagnostics.some((d) => d.code === 'E015')).toBe(true);
  });

  it('treats a `.` after an expression atom as postfix field access, not a path', () => {
    expect(kinds('x.foo')).toEqual(['identifier', '.', 'identifier', 'eof']);
  });

  it('treats a `.` after `(` as the start of a path', () => {
    expect(kinds('f(.foo)')).toEqual(['identifier', '(', 'path', ')', 'eof']);
  });

  it('treats a `.` after `)` as postfix field access', () => {
    expect(kinds('f().foo')).toEqual(['identifier', '(', ')', '.', 'identifier', 'eof']);
  });
});

describe('lexer: operators and punctuation', () => {
  it('lexes every operator', () => {
    expect(kinds('( ) [ ] { } , : = => == != < <= > >= + - * / ! ?? || &&')).toEqual([
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      ',',
      ':',
      '=',
      '=>',
      '==',
      '!=',
      '<',
      '<=',
      '>',
      '>=',
      '+',
      '-',
      '*',
      '/',
      '!',
      '??',
      '||',
      '&&',
      'eof',
    ]);
  });

  it('lexes `%` as modulo right after an operand, and as a metadata path otherwise', () => {
    expect(kinds('x % y')).toEqual(['identifier', '%', 'identifier', 'eof']);
    expect(kinds('%source_id')).toEqual(['metadataPath', 'eof']);
  });

  it('lexes closure pipes', () => {
    expect(kinds('|k, v| k')).toEqual([
      '|',
      'identifier',
      ',',
      'identifier',
      '|',
      'identifier',
      'eof',
    ]);
  });
});

describe('lexer: comments', () => {
  it('attaches a leading comment to the next token', () => {
    const { tokens } = lex(new SourceFile('<test>', '# hello\nlet x = 1'));
    const letToken = tokens.find((t) => t.token.kind === 'let')!;
    expect(letToken.leadingComments).toHaveLength(1);
    expect(letToken.leadingComments[0]!.text).toBe('hello');
  });

  it('attaches a trailing comment to the previous token', () => {
    const { tokens } = lex(new SourceFile('<test>', 'let x = 1 # comment'));
    const oneToken = tokens.find((t) => t.token.kind === 'int')!;
    expect(oneToken.trailingComment?.text).toBe('comment');
  });

  it('does not emit tokens for comments', () => {
    expect(kinds('# just a comment')).toEqual(['eof']);
  });
});

describe('lexer: newlines and statement termination', () => {
  it('emits a newline token between statements', () => {
    expect(kinds('let x = 1\nlet y = 2')).toEqual([
      'let',
      'identifier',
      '=',
      'int',
      'newline',
      'let',
      'identifier',
      '=',
      'int',
      'eof',
    ]);
  });

  it('collapses consecutive blank lines into a single newline token', () => {
    expect(kinds('let x = 1\n\n\nlet y = 2')).toEqual([
      'let',
      'identifier',
      '=',
      'int',
      'newline',
      'let',
      'identifier',
      '=',
      'int',
      'eof',
    ]);
  });

  it('does not emit a newline inside unclosed parens', () => {
    expect(kinds('f(\n 1,\n 2\n)')).toEqual(['identifier', '(', 'int', ',', 'int', ')', 'eof']);
  });

  it('does not emit a newline inside unclosed brackets', () => {
    expect(kinds('[\n 1,\n 2\n]')).toEqual(['[', 'int', ',', 'int', ']', 'eof']);
  });

  it('treats a newline after a binary operator as continuation', () => {
    expect(kinds('1 +\n2')).toEqual(['int', '+', 'int', 'eof']);
  });

  it('treats a newline after `,` as continuation', () => {
    expect(kinds('let x = 1,\nlet y = 2')).not.toContain('newline');
  });

  it('treats `;` as a token of its own kind', () => {
    expect(kinds('let x = 1; let y = 2')).toEqual([
      'let',
      'identifier',
      '=',
      'int',
      ';',
      'let',
      'identifier',
      '=',
      'int',
      'eof',
    ]);
  });
});

describe('lexer: unexpected characters', () => {
  it('produces an error token and continues', () => {
    const { tokens, diagnostics } = lex(new SourceFile('<test>', 'let x = 1 $ let y = 2'));
    expect(diagnostics.some((d) => d.code === 'E013')).toBe(true);
    expect(tokens.some((t) => t.token.kind === 'error')).toBe(true);
    expect(tokens.some((t) => t.token.kind === 'let')).toBe(true);
    expect(tokens[tokens.length - 1]!.token.kind).toBe('eof');
  });
});

describe('lexer: property — never throws on arbitrary input', () => {
  it('handles any string without throwing and always ends with eof', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const { tokens } = lex(new SourceFile('<fuzz>', text));
        expect(tokens[tokens.length - 1]!.token.kind).toBe('eof');
      }),
    );
  });

  it('handles arbitrary unicode text without throwing', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        expect(() => lex(new SourceFile('<fuzz>', text))).not.toThrow();
      }),
    );
  });
});

describe('lexer: line/column index (SourceFile)', () => {
  it('computes line and column for offsets', () => {
    const s = new SourceFile('<t>', 'ab\ncd\nef');
    expect(s.lineColumnAt(0)).toEqual({ line: 1, column: 1 });
    expect(s.lineColumnAt(2)).toEqual({ line: 1, column: 3 });
    expect(s.lineColumnAt(3)).toEqual({ line: 2, column: 1 });
    expect(s.lineColumnAt(8)).toEqual({ line: 3, column: 3 });
  });

  it('reports line text without the trailing newline', () => {
    const s = new SourceFile('<t>', 'first\r\nsecond\nthird');
    expect(s.lineText(1)).toBe('first');
    expect(s.lineText(2)).toBe('second');
    expect(s.lineText(3)).toBe('third');
    expect(s.lineCount).toBe(3);
  });
});
