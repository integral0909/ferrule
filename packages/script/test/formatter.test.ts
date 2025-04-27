import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { format, parse, SourceFile } from '@ferrule/script';
import { dumpProgram } from './astDump.js';

function dumpOf(text: string): string {
  const { program, diagnostics } = parse(new SourceFile('<t>', text));
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `unexpected diagnostics: ${errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`,
    );
  }
  return dumpProgram(program);
}

/** Asserts that formatting preserves the program's meaning: same AST shape, modulo spans/trivia. */
function expectRoundTrips(text: string): string {
  const formatted = format(text);
  expect(dumpOf(formatted)).toBe(dumpOf(text));
  return formatted;
}

describe('formatter: basic reprinting', () => {
  it('formats a let and an expression statement', () => {
    expect(format('let   x   =   1\nx')).toBe('let x = 1\nx\n');
  });

  it('formats let mut', () => {
    expect(format('let mut x = 1')).toBe('let mut x = 1\n');
  });

  it('formats error capture', () => {
    expect(format('let v,err=to_int(.x)')).toBe('let v, err = to_int(.x)\n');
  });

  it('formats path and metadata path literals', () => {
    expect(format('.a.b[0]')).toBe('.a.b[0]\n');
    expect(format('%source_id')).toBe('%source_id\n');
  });

  it('canonicalizes float literals', () => {
    expect(format('2.0')).toBe('2.0\n');
    expect(format('2.50')).toBe('2.5\n');
  });

  it('always quotes object keys', () => {
    expect(format('{a: 1}')).toBe('{\n  "a": 1,\n}\n');
  });
});

describe('formatter: operator precedence is preserved with minimal parens', () => {
  it('does not add parens that are not needed', () => {
    expect(format('1 + 2 * 3')).toBe('1 + 2 * 3\n');
  });

  it('adds parens to preserve grouping', () => {
    expect(format('(1 + 2) * 3')).toBe('(1 + 2) * 3\n');
  });

  it('adds parens for right-associativity concerns on subtraction', () => {
    const formatted = format('1 - (2 - 3)');
    expect(formatted).toBe('1 - (2 - 3)\n');
    expect(dumpOf(formatted)).toBe(dumpOf('1 - (2 - 3)'));
  });

  it('round-trips a chain of field/index/call postfix operators', () => {
    expectRoundTrips('parse_json(.raw).items[0].id');
  });
});

describe('formatter: control flow and closures', () => {
  it('formats if/else if/else', () => {
    const out = format('if a{1}else if b{2}else{3}');
    expect(out).toBe('if a {\n  1\n} else if b {\n  2\n} else {\n  3\n}\n');
  });

  it('formats match with several pattern kinds', () => {
    expectRoundTrips(
      'match x {\n  1 => "one",\n  string => "s",\n  { a, b: c } => "obj",\n  _ => "other",\n}',
    );
  });

  it('formats closures with and without a block body', () => {
    expect(format('|k,v|k')).toBe('|k, v| k\n');
    expectRoundTrips('|x| { x }');
  });

  it('formats drop and abort', () => {
    expect(format('drop')).toBe('drop\n');
    expect(format('abort')).toBe('abort\n');
    expect(format('abort "bad"')).toBe('abort "bad"\n');
  });
});

describe('formatter: strings', () => {
  it('reformats interpolation with normalized spacing', () => {
    expect(format('"hi {{name}}"')).toBe('"hi {{ name }}"\n');
  });

  it('round-trips escapes', () => {
    expectRoundTrips(String.raw`"a\nb\tc\\d\"e"`);
  });

  it('round-trips a raw string', () => {
    expectRoundTrips(String.raw`r'no \escapes'`);
  });

  it('round-trips a timestamp and a regex literal', () => {
    expectRoundTrips("t'2026-01-01T00:00:00Z'");
    expectRoundTrips('r/^\\d+$/i');
  });
});

describe('formatter: comments', () => {
  it('preserves a leading comment before a statement', () => {
    expect(format('# hello\nlet x = 1')).toBe('# hello\nlet x = 1\n');
  });

  it('preserves a trailing comment on the same line', () => {
    expect(format('let x = 1 # keep me')).toBe('let x = 1  # keep me\n');
  });

  it('preserves a blank line before a comment block', () => {
    const out = format('let x = 1\n\n# separated\nlet y = 2');
    expect(out).toBe('let x = 1\n\n# separated\nlet y = 2\n');
  });

  it('preserves comments inside an object literal', () => {
    const src = 'let o = {\n  # about a\n  "a": 1,\n  "b": 2, # about b\n}';
    const out = format(src);
    expect(out).toContain('# about a');
    expect(out).toContain('# about b');
  });

  it('preserves end-of-program trailing comments', () => {
    expect(format('let x = 1\n# trailing')).toBe('let x = 1\n# trailing\n');
  });
});

describe('formatter: test declarations', () => {
  it('formats a test block', () => {
    const src = 'test "t" { given {"level":"WARN"} expect {"level":"warn"} }';
    const out = format(src);
    expect(out).toBe(
      [
        'test "t" {',
        '  given {',
        '    "level": "WARN",',
        '  }',
        '  expect {',
        '    "level": "warn",',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });
});

describe('formatter: idempotence', () => {
  const samples = [
    'let x = 1',
    'let mut x = 1\nx = 2',
    'let v, err = to_int(.x)',
    '.a.b[0] = 1',
    'if a { 1 } else if b { 2 } else { 3 }',
    'match x {\n  1 => "a",\n  _ => "b",\n}',
    '|k, v| k + v',
    '[1, 2, 3]',
    '{"a": 1, "b": {"c": 2}}',
    '"hi {{ name }}, you are {{ 1 + 2 }}"',
    'to_int(.code) ?? 0',
    'upcase(.status)!',
    'let o = {"a": "x"}\nmap_values(o, |k, v| upcase(v) ?? v)',
    'test "t" {\n  given { "a": 1 }\n  expect { "a": 2 }\n}',
    '# comment\nlet x = 1  # trailing\n\n# another\nlet y = 2',
  ];

  it.each(samples)('format(format(x)) === format(x) for %j', (src) => {
    const once = format(src);
    const twice = format(once);
    expect(twice).toBe(once);
  });

  it('is idempotent and meaning-preserving over generated programs', () => {
    fc.assert(
      fc.property(programArbitrary(), (src) => {
        const once = format(src);
        const twice = format(once);
        expect(twice).toBe(once);
        expect(dumpOf(once)).toBe(dumpOf(src));
      }),
    );
  });
});

describe('formatter: never throws', () => {
  it('does not throw on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        expect(() => format(text)).not.toThrow();
      }),
    );
  });
});

// ---- generator for small, well-formed programs -------------------------------------------------

function exprArbitrary(depth: number): fc.Arbitrary<string> {
  const idents = fc.constantFrom('x', 'y', 'status', 'count');
  const leaves: fc.Arbitrary<string> = fc.oneof(
    fc.integer({ min: -1000, max: 1000 }).map((n) => String(n)),
    fc.constantFrom('true', 'false', 'null', '"hello"', '.a.b', '%source_id'),
    idents,
  );
  if (depth <= 0) return leaves;
  const smaller = exprArbitrary(depth - 1);
  return fc.oneof(
    { weight: 3, arbitrary: leaves },
    {
      weight: 1,
      arbitrary: fc
        .tuple(smaller, fc.constantFrom('+', '-', '*', '&&', '||'), smaller)
        .map(([a, op, b]) => `${a} ${op} ${b}`),
    },
    {
      weight: 1,
      arbitrary: fc.array(smaller, { maxLength: 3 }).map((els) => `[${els.join(', ')}]`),
    },
  );
}

function statementArbitrary(): fc.Arbitrary<string> {
  const ident = fc.constantFrom('x', 'y', 'z');
  return fc.oneof(
    fc.tuple(ident, exprArbitrary(2)).map(([name, e]) => `let ${name} = ${e}`),
    fc.tuple(ident, exprArbitrary(2)).map(([name, e]) => `let mut ${name} = ${e}`),
    exprArbitrary(2),
  );
}

function programArbitrary(): fc.Arbitrary<string> {
  return fc
    .array(statementArbitrary(), { minLength: 1, maxLength: 6 })
    .map((stmts) => stmts.join('\n'));
}
