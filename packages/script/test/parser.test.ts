import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parse, SourceFile } from '@ferrule/script';
import { dumpProgram } from './astDump.js';

function d(text: string): string {
  const { program, diagnostics } = parse(new SourceFile('<test>', text));
  const errors = diagnostics.filter((x) => x.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `unexpected diagnostics for ${JSON.stringify(text)}: ${errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`,
    );
  }
  return dumpProgram(program);
}

function errorsOf(text: string): readonly string[] {
  const { diagnostics } = parse(new SourceFile('<test>', text));
  return diagnostics.filter((x) => x.severity === 'error').map((x) => x.code);
}

describe('parser: literals and primaries', () => {
  it('parses literals', () => {
    expect(d('1')).toBe('1');
    expect(d('-1')).toBe('-1');
    expect(d('1.5')).toBe('1.5f');
    expect(d('true')).toBe('true');
    expect(d('false')).toBe('false');
    expect(d('null')).toBe('null');
    expect(d('"hi"')).toBe('(str "hi")');
    expect(d("r'raw'")).toBe('(raw "raw")');
    expect(d('b"\\x00"')).toBe('(bytes 0)');
    expect(d("t'2026-01-01T00:00:00Z'")).toBe('(ts "2026-01-01T00:00:00Z")');
    expect(d('r/a+/i')).toBe('(regex "a+" "i")');
  });

  it('parses paths and metadata paths', () => {
    expect(d('.')).toBe('(path [])');
    expect(d('.a.b[0]')).toBe('(path ["a","b",0])');
    expect(d('%source_id')).toBe('(meta source_id)');
  });

  it('parses identifiers, arrays, and objects', () => {
    expect(d('x')).toBe('x');
    expect(d('[1, 2, 3]')).toBe('(array 1 2 3)');
    expect(d('{"a": 1, "b": 2}')).toBe('(object a=1 b=2)');
    expect(d('{}')).toBe('(object )');
  });

  it('parses string interpolation into a nested expression', () => {
    expect(d('"hi {{ name }}"')).toBe('(str "hi " $(name))');
    expect(d('"{{ 1 + 2 }}"')).toBe('(str $((+ 1 2)))');
  });
});

describe('parser: operators and precedence', () => {
  it('respects the precedence table', () => {
    expect(d('1 + 2 * 3')).toBe('(+ 1 (* 2 3))');
    expect(d('(1 + 2) * 3')).toBe('(* (+ 1 2) 3)');
    expect(d('1 + 2 - 3')).toBe('(- (+ 1 2) 3)');
    expect(d('a || b && c')).toBe('(|| a (&& b c))');
    expect(d('a ?? b || c')).toBe('(?? a (|| b c))');
    expect(d('1 == 2')).toBe('(== 1 2)');
    expect(d('-x')).toBe('(- x)');
    expect(d('!x')).toBe('(! x)');
    expect(d('!x && y')).toBe('(&& (! x) y)');
  });

  it('rejects chained comparisons', () => {
    expect(errorsOf('1 < 2 < 3')).toContain('E101');
  });

  it('parses `is` as a type test', () => {
    expect(d('.x is string')).toBe('(is (path ["x"]) string)');
  });

  it('parses postfix field access, indexing, calls, and assert', () => {
    expect(d('x.foo')).toBe('(field x foo)');
    expect(d('x[0]')).toBe('(index x 0)');
    expect(d('f(1, 2)')).toBe('(call f 1 2)');
    expect(d('f(x: 1, y: 2)')).toBe('(call f x:1 y:2)');
    expect(d('to_int(.x)!')).toBe('(assert (call to_int (path ["x"])))');
    expect(d('a.b.c[0](x)')).toBe('(call (index (field (field a b) c) 0) x)');
  });

  it('parses a chained pipeline-like expression', () => {
    expect(d('parse_json(.raw).items[0].id')).toBe(
      '(field (index (field (call parse_json (path ["raw"])) items) 0) id)',
    );
  });
});

describe('parser: let, assignment, error capture', () => {
  it('parses let and let mut', () => {
    expect(d('let x = 1')).toBe('(let x 1)');
    expect(d('let mut x = 1')).toBe('(let-mut x 1)');
  });

  it('parses error capture', () => {
    expect(d('let v, err = to_int(.x)')).toBe('(let-capture v err (call to_int (path ["x"])))');
  });

  it('parses path assignment and variable reassignment', () => {
    expect(d('.a = 1')).toBe('(assign (path ["a"]) 1)');
    expect(d('let mut x = 1\nx = 2')).toBe('(let-mut x 1)\n(assign x 2)');
  });

  it('flags an invalid assignment target', () => {
    expect(errorsOf('1 = 2')).toContain('E108');
  });
});

describe('parser: if/else, match, closures, drop/abort', () => {
  it('parses if/else if/else', () => {
    expect(d('if a { 1 } else if b { 2 } else { 3 }')).toBe(
      '(if a (block -> 1) (if b (block -> 2) (block -> 3)))',
    );
  });

  it('parses match with several pattern kinds', () => {
    const src = `match x {
      1 => "one",
      string => "a string",
      r/^\\d+$/ => "digits",
      { status, code: c } => "shape",
      _ => "other",
    }`;
    expect(d(src)).toBe(
      '(match x [1 => (str "one")] [(kind string) => (str "a string")] [(regexPat "^\\\\d+$") => (str "digits")] [(objPat status code:c) => (str "shape")] [_ => (str "other")])',
    );
  });

  it('parses closures with and without a block body', () => {
    expect(d('|k, v| k')).toBe('(closure (k v) k)');
    expect(d('|x| { x }')).toBe('(closure (x) (block -> x))');
  });

  it('parses drop and abort', () => {
    expect(d('drop')).toBe('(drop)');
    expect(d('abort')).toBe('(abort)');
    expect(d('abort "bad"')).toBe('(abort (str "bad"))');
  });

  it('parses a block that ends in a statement (no trailing value)', () => {
    expect(d('let x = 1\nlet y = 2')).toBe('(let x 1)\n(let y 2)');
  });
});

describe('parser: test declarations', () => {
  it('parses a test block', () => {
    const src = `test "normalises level" {
      given { "level": "WARN" }
      expect { "level": "warn" }
    }`;
    expect(d(src)).toBe(
      '(test "normalises level" (object level=(str "WARN")) (object level=(str "warn")))',
    );
  });
});

describe('parser: individual diagnostic codes', () => {
  it('E102: expected an expression', () => {
    expect(errorsOf('let x = )')).toContain('E102');
  });

  it('E103: expected a statement terminator', () => {
    expect(errorsOf('let x = 1 let y = 2')).toContain('E103');
  });

  it('E104: expected an identifier', () => {
    expect(errorsOf('let 1 = 2')).toContain('E104');
    expect(errorsOf('x.1')).toContain('E104');
  });

  it('E105: expected a pattern', () => {
    expect(errorsOf('match x {\n  => 1,\n}')).toContain('E105');
  });

  it('E106: duplicate named argument', () => {
    expect(errorsOf('f(x: 1, x: 2)')).toContain('E106');
  });

  it('E107: positional argument after named argument', () => {
    expect(errorsOf('f(x: 1, 2)')).toContain('E107');
  });

  it('E109: expected a block', () => {
    expect(errorsOf('if x 1')).toContain('E109');
  });

  it('E110: duplicate object key', () => {
    expect(errorsOf('{"a": 1, "a": 2}')).toContain('E110');
  });

  it('E111: invalid closure parameters', () => {
    expect(errorsOf('|1| x')).toContain('E111');
  });

  it("E112: expected '=>'", () => {
    expect(errorsOf('match x {\n  string 1,\n}')).toContain('E112');
  });

  it('does not report false positives for well-formed programs using these constructs', () => {
    expect(
      errorsOf('f(1, x: 2)\nmatch x {\n  string => 1,\n  _ => 2,\n}\nif x { 1 } else { 2 }'),
    ).toEqual([]);
  });
});

describe('parser: newlines vs continuation inside the grammar', () => {
  it('treats a trailing binary operator as a continuation across the assignment', () => {
    expect(d('let x =\n  1 +\n  2')).toBe('(let x (+ 1 2))');
  });

  it('allows multi-line call arguments', () => {
    expect(
      d(`f(
      1,
      2,
    )`),
    ).toBe('(call f 1 2)');
  });
});

describe('parser: error recovery', () => {
  it('reports multiple diagnostics in one pass and keeps parsing', () => {
    const src = 'let x = \nlet y = 2\nlet = 3\nlet z = 4';
    const { diagnostics, program } = parse(new SourceFile('<test>', src));
    expect(diagnostics.filter((d2) => d2.severity === 'error').length).toBeGreaterThanOrEqual(1);
    // Recovery should still find the well-formed statements around the bad one.
    const names = program.statements
      .filter((s): s is Extract<typeof s, { kind: 'let' }> => s.kind === 'let')
      .map((s) => s.name);
    expect(names).toContain('y');
    expect(names).toContain('z');
  });

  it('recovers from an unterminated string and keeps parsing later statements', () => {
    const src = 'let x = "unterminated\nlet y = 2';
    const { diagnostics, program } = parse(new SourceFile('<test>', src));
    expect(diagnostics.some((d2) => d2.code === 'E001')).toBe(true);
    expect(program.statements.some((s) => s.kind === 'let' && s.name === 'y')).toBe(true);
  });

  it('never throws on malformed input', () => {
    const samples = [
      '',
      '   ',
      '(((',
      ')))',
      'let',
      'let x',
      'let x =',
      'if',
      'if x',
      'match x {',
      '{ "a": }',
      '.a.b[',
      'f(',
      '|',
      'x = ',
      '=> => =>',
      '"{{ {{ }}',
    ];
    for (const s of samples) {
      expect(() => parse(new SourceFile('<t>', s))).not.toThrow();
    }
  });
});

describe('parser: property — never throws on arbitrary input', () => {
  it('handles arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        expect(() => parse(new SourceFile('<fuzz>', text))).not.toThrow();
      }),
    );
  });

  it('handles token-soup built from language fragments', () => {
    const fragments = [
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
      '+',
      '-',
      '*',
      '/',
      '%',
      '!',
      '??',
      '||',
      '&&',
      '.',
      '.a.b[0]',
      '%meta',
      'x',
      '1',
      '"s"',
      '\n',
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...fragments), { maxLength: 40 }), (parts) => {
        const text = parts.join(' ');
        expect(() => parse(new SourceFile('<fuzz>', text))).not.toThrow();
      }),
    );
  });
});
