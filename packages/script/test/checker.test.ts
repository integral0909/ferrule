import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  check,
  createDefaultRegistry,
  formatExprType,
  formatType,
  intType,
  objectType,
  parse,
  SourceFile,
  stringType,
  type Type,
  unionType,
} from '@ferrule/script';

function checkSource(text: string, inputSchema?: Type) {
  const { program, diagnostics: parseDiagnostics } = parse(new SourceFile('<test>', text));
  const result = check(program, inputSchema === undefined ? {} : { inputSchema });
  return { result, diagnostics: [...parseDiagnostics, ...result.diagnostics] };
}

function codesOf(text: string, inputSchema?: Type): readonly string[] {
  return checkSource(text, inputSchema).diagnostics.map((d) => d.code);
}

function errorsOf(text: string, inputSchema?: Type): readonly string[] {
  return checkSource(text, inputSchema)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.code);
}

function typeOfLastExprStatement(text: string): string {
  const { program } = parse(new SourceFile('<test>', text));
  const result = check(program);
  const last = program.statements[program.statements.length - 1]!;
  if (last.kind !== 'exprStatement') throw new Error('expected an expression statement');
  return formatExprType(result.typeOf(last.expr));
}

describe('checker: literals and basic expressions', () => {
  it('types literals', () => {
    expect(typeOfLastExprStatement('1')).toBe('int');
    expect(typeOfLastExprStatement('1.5')).toBe('float');
    expect(typeOfLastExprStatement('"s"')).toBe('string');
    expect(typeOfLastExprStatement('true')).toBe('bool');
    expect(typeOfLastExprStatement('null')).toBe('null');
  });

  it('reports no diagnostics for a clean program', () => {
    expect(errorsOf('let x = 1\nlet y = x + 1')).toEqual([]);
  });
});

describe('checker: scoping and undefined variables', () => {
  it('flags an undefined variable with a suggestion', () => {
    const { diagnostics } = checkSource('let count = 1\nlet y = coutn + 1');
    const e = diagnostics.find((d) => d.code === 'E201');
    expect(e).toBeDefined();
    expect(e!.notes.join(' ')).toContain('count');
  });

  it('flags redeclaration in the same scope', () => {
    expect(errorsOf('let x = 1\nlet x = 2')).toContain('E203');
  });

  it('allows shadowing in a nested scope', () => {
    expect(errorsOf('let x = 1\nif true { let x = 2\nx }')).not.toContain('E203');
  });

  it('flags assignment to an immutable variable', () => {
    expect(errorsOf('let x = 1\nx = 2')).toContain('E204');
  });

  it('allows assignment to a mutable variable of a compatible type', () => {
    expect(errorsOf('let mut x = 1\nx = 2')).toEqual([]);
  });

  it("flags an assignment that changes a variable's type", () => {
    expect(errorsOf('let mut x = 1\nx = "s"')).toContain('E301');
  });

  it('warns about an unused variable', () => {
    expect(codesOf('let unused = 1')).toContain('E205');
  });

  it('does not warn about a variable prefixed with underscore', () => {
    expect(codesOf('let _ignored = 1')).not.toContain('E205');
  });
});

describe('checker: fallibility', () => {
  it('flags an unhandled fallible call', () => {
    expect(errorsOf('let x = to_int(.code)')).toContain('E401');
  });

  it('accepts `??` handling', () => {
    expect(errorsOf('let x = to_int(.code) ?? 0')).toEqual([]);
  });

  it('accepts `!` handling', () => {
    expect(errorsOf('let x = to_int(.code)!')).toEqual([]);
  });

  it('accepts error-capture handling', () => {
    expect(errorsOf('let x, err = to_int(.code)')).toEqual([]);
  });

  it('warns W502 for an unused error-capture binding, distinct from E205', () => {
    const codes = codesOf('let x, err = to_int(.code)\nx');
    expect(codes).toContain('W502');
    expect(codes).not.toContain('E205');
  });

  it('does not warn about an unused error binding named with an underscore', () => {
    const codes = codesOf('let x, _ = to_int(.code)\nx');
    expect(codes).not.toContain('W502');
  });

  it('still warns E205 for an unused error-capture *value* binding', () => {
    const codes = codesOf('let x, err = to_int(.code)\nerr');
    expect(codes).toContain('E205');
    expect(codes).not.toContain('W502');
  });

  it('removes the `!` after handling: `to_int(.code) ?? 0` is `int`', () => {
    expect(typeOfLastExprStatement('to_int(.code) ?? 0')).toBe('int');
  });

  it('makes a call fallible when an argument type does not match, even if the function itself never fails', () => {
    // .status : any, upcase expects string -> mismatch makes the call fallible
    expect(typeOfLastExprStatement('upcase(.status) ?? "x"')).toBe('string');
    expect(errorsOf('upcase(.status)')).toContain('E401');
  });

  it('does not require handling when the argument type is known to match exactly', () => {
    expect(errorsOf('let x = "a"\nupcase(x)')).toEqual([]);
  });

  it('flags redundant `!` on an infallible expression', () => {
    expect(codesOf('let x = "a"\nupcase(x)!')).toContain('E402');
  });

  it('flags redundant `??` when the left side cannot be null or fail', () => {
    expect(codesOf('let x = "a"\nupcase(x) ?? "y"')).toContain('W501');
  });

  it('does not flag `??` as redundant on a nullable path', () => {
    expect(codesOf('.a ?? "y"')).not.toContain('W501');
  });

  it('/ and % on int are fallible; on float they are not', () => {
    expect(errorsOf('let x = 1 / 2')).toContain('E401');
    expect(errorsOf('let x = 1 / 2 ?? 0')).toEqual([]);
    expect(errorsOf('let x = 1.0 / 2.0')).toEqual([]);
  });
});

describe('checker: parse_regex return-type inference', () => {
  it('infers a closed object type with one string field per named group, from a regex literal', () => {
    expect(
      typeOfLastExprStatement(
        String.raw`let parsed = parse_regex(.msg, r/(?<ip>\S+) (?<code>\d+)/) ?? abort` +
          '\nparsed',
      ),
    ).toBe('object { ip: string, code: string }');
  });

  it('infers the same shape from a constant string pattern', () => {
    expect(
      typeOfLastExprStatement(
        String.raw`let parsed = parse_regex(.msg, "(?<ip>\S+)") ?? abort` + '\nparsed',
      ),
    ).toBe('object { ip: string }');
  });

  it('a field access on the inferred shape type-checks as string, not any', () => {
    expect(
      errorsOf(
        String.raw`let parsed = parse_regex(.msg, r/(?<ip>\S+)/) ?? abort` +
          '\nlet ip = upcase(parsed.ip)',
      ),
    ).toEqual([]);
  });

  it('accessing an undeclared field on the inferred (closed) shape is an error', () => {
    expect(
      errorsOf(
        String.raw`let parsed = parse_regex(.msg, r/(?<ip>\S+)/) ?? abort` + '\nparsed.nope',
      ),
    ).toContain('E302');
  });

  it('falls back to an open object type for a dynamic (non-literal) pattern', () => {
    expect(
      typeOfLastExprStatement('let parsed = parse_regex(.msg, .pattern) ?? abort\nparsed'),
    ).toBe('object { ..any }');
  });

  it('falls back to an open object type when numeric_groups is true', () => {
    expect(
      typeOfLastExprStatement(
        String.raw`let parsed = parse_regex(.msg, r/(?<ip>\S+)/, numeric_groups: true) ?? abort` +
          '\nparsed',
      ),
    ).toBe('object { ..any }');
  });
});

describe('checker: type errors', () => {
  it('never implicitly mixes int and float', () => {
    expect(errorsOf('let x = 1 + 1.5')).toContain('E305');
  });

  it('flags calling upcase on a non-string when the type is statically known', () => {
    expect(errorsOf('let x = 1\nupcase(x)')).toContain('E401'); // int is not a subtype of string -> mismatch -> fallible -> must be handled
  });

  it('flags too few / too many arguments', () => {
    expect(errorsOf('to_int()')).toContain('E303');
    expect(errorsOf('to_int(1, 2)')).toContain('E303');
  });

  it('flags an unknown named parameter with a suggestion', () => {
    const { diagnostics } = checkSource('parse_regex(".", flgs: "i")');
    expect(diagnostics.some((d) => d.code === 'E304')).toBe(true);
  });

  it('flags calling an undefined function with a suggestion', () => {
    const { diagnostics } = checkSource('to_inn(1)');
    const e = diagnostics.find((d) => d.code === 'E202');
    expect(e).toBeDefined();
    expect(e!.notes.join(' ')).toContain('to_int');
  });

  it('requires del/exists to take a literal path argument', () => {
    expect(errorsOf('let x = 1\ndel(x)')).toContain('E301');
    expect(errorsOf('del(.a)')).toEqual([]);
  });

  it('flags unknown field access on a closed object type', () => {
    expect(errorsOf('let o = {"a": 1}\no.b')).toContain('E302');
  });

  it('allows field access on an open object rest type', () => {
    const schema = objectType({}, stringType);
    expect(errorsOf('.anything', schema)).toEqual([]);
  });

  it('flags a non-boolean `if` condition', () => {
    expect(errorsOf('if 1 { 1 }')).toContain('E306');
  });

  it('rejects comparing incompatible types', () => {
    expect(errorsOf('let x = 1 == "s"')).toContain('E301');
  });

  it('flags indexing a non-indexable type with E307', () => {
    expect(errorsOf('let x = 1\nx[0]')).toContain('E307');
  });

  it('allows indexing an array and an object', () => {
    expect(errorsOf('let a = [1, 2]\na[0] ?? 0')).toEqual([]);
    expect(errorsOf('let o = {"a": 1}\no["a"] ?? 0')).toEqual([]);
  });

  it('flags calling a non-identifier expression with E308', () => {
    expect(errorsOf('(1)(2)')).toContain('E308');
  });
});

describe('checker: typed paths from an input schema', () => {
  const schema = objectType({ status: unionType([stringType]), count: intType });

  it('types a known field from the schema', () => {
    const { program } = parse(new SourceFile('<t>', '.status'));
    const result = check(program, { inputSchema: schema });
    const stmt = program.statements[0]!;
    if (stmt.kind !== 'exprStatement') throw new Error('expected expr statement');
    expect(formatType(result.typeOf(stmt.expr).type)).toBe('string');
  });

  it('types a missing field on a closed schema as null', () => {
    const { program } = parse(new SourceFile('<t>', '.nope'));
    const result = check(program, { inputSchema: schema });
    const stmt = program.statements[0]!;
    if (stmt.kind !== 'exprStatement') throw new Error('expected expr statement');
    expect(formatType(result.typeOf(stmt.expr).type)).toBe('null');
  });

  it("checks a `test` block's given/expect fields against the schema", () => {
    const src = `test "t" {
      given { "status": 1 }
      expect { "status": "ok" }
    }`;
    expect(errorsOf(src, schema)).toContain('E301');
  });

  it('accepts a `test` block whose fields match the schema', () => {
    const src = `test "t" {
      given { "status": "ok", "count": 1 }
      expect { "status": "ok" }
    }`;
    expect(errorsOf(src, schema)).toEqual([]);
  });

  it('leaves fields the schema does not mention unchecked in a `test` block', () => {
    const src = `test "t" {
      given { "extra": "anything" }
      expect { "extra": 123 }
    }`;
    expect(errorsOf(src, schema)).toEqual([]);
  });
});

describe('checker: flow narrowing', () => {
  it('narrows a variable inside `if is_string(x) { ... }`', () => {
    const src = 'let x = .v\nif is_string(x) { upcase(x) }';
    expect(errorsOf(src)).toEqual([]);
  });

  it('narrows via `x is string`', () => {
    const src = 'let x = .v\nif x is string { upcase(x) }';
    expect(errorsOf(src)).toEqual([]);
  });

  it('does not narrow outside the `if` branch', () => {
    const src = 'let x = .v\nif is_string(x) { upcase(x) }\nupcase(x)';
    // Second upcase(x) is outside the narrowed branch, x is still `any` -> fallible -> unhandled.
    expect(errorsOf(src)).toContain('E401');
  });

  it('narrows through a match kind pattern', () => {
    const src = 'let x = .v\nmatch x {\n  string => upcase(x),\n  _ => "other",\n}';
    expect(errorsOf(src)).toEqual([]);
  });

  it('narrows a path directly', () => {
    expect(errorsOf('if is_string(.v) { upcase(.v) }')).toEqual([]);
  });

  it('narrows through a conjunction of `&&`', () => {
    expect(errorsOf('let x = .v\nif is_string(x) && true { upcase(x) }')).toEqual([]);
  });
});

describe('checker: match', () => {
  it('accepts an exhaustive match with a wildcard', () => {
    expect(errorsOf('match .v {\n  string => 1,\n  _ => 2,\n}')).toEqual([]);
  });

  it('flags a non-exhaustive match', () => {
    expect(errorsOf('match .v {\n  string => 1,\n}')).toContain('E309');
  });

  it('flags duplicate literal arms', () => {
    expect(errorsOf('match .v {\n  1 => "a",\n  1 => "b",\n  _ => "c",\n}')).toContain('E310');
  });

  it('does not flag two distinct string-literal arms as duplicates', () => {
    // Regression test: `literalKey` used to key every string-literal pattern on `pattern.value`,
    // a field `StringLiteral` doesn't have (its text lives in `.parts`), so every string pattern
    // collapsed to the same key and any two of them were wrongly flagged as duplicates.
    expect(errorsOf('match .v {\n  "error" => 1,\n  "warn" => 2,\n  _ => 3,\n}')).not.toContain(
      'E310',
    );
  });

  it('still flags two identical string-literal arms as duplicates', () => {
    expect(errorsOf('match .v {\n  "error" => 1,\n  "error" => 2,\n  _ => 3,\n}')).toContain(
      'E310',
    );
  });

  it('destructures an object pattern', () => {
    const schema = objectType({ status: stringType });
    expect(errorsOf('match . {\n  { status } => upcase(status),\n  _ => "x",\n}', schema)).toEqual(
      [],
    );
  });
});

describe('checker: unreachable code', () => {
  it('flags code after drop', () => {
    expect(codesOf('drop\nlet x = 1')).toContain('E206');
  });

  it('flags code after abort', () => {
    expect(codesOf('abort "no"\nlet x = 1')).toContain('E206');
  });

  it('only reports unreachable once for a run of statements', () => {
    const codes = codesOf('drop\nlet x = 1\nlet y = 2');
    expect(codes.filter((c) => c === 'E206')).toHaveLength(1);
  });
});

describe('checker: closures and higher-order functions', () => {
  it('type-checks map_values with a closure', () => {
    expect(errorsOf('let o = {"a": "x"}\nmap_values(o, |k, v| upcase(v) ?? v)')).toEqual([]);
  });

  it('flags a closure with the wrong arity', () => {
    expect(errorsOf('let o = {"a": "x"}\nmap_values(o, |k| k)')).toContain('E111');
  });

  it('flags a stray closure used outside a call', () => {
    expect(errorsOf('|x| x')).toContain('E301');
  });

  it('type-checks filter and echoes the array element type', () => {
    const src = 'let items = [1, 2, 3]\nfilter(items, |x| x > 1)';
    expect(typeOfLastExprStatement(src)).toBe('array<int>');
  });
});

describe('checker: registry parameter is respected', () => {
  it('uses a custom registry instead of the default', () => {
    const { program } = parse(new SourceFile('<t>', 'only_mine(1)'));
    const registry = createDefaultRegistry();
    registry.register({
      name: 'only_mine',
      params: [],
      returnType: intType,
      fallible: 'never',
      pure: true,
      docs: '',
      examples: [],
    });
    const result = check(program, { registry });
    expect(result.diagnostics.some((d) => d.code === 'E303')).toBe(true); // too many args (0 expected)
  });
});

describe('checker: resolved call map', () => {
  it('records which signature a call resolved to', () => {
    const { program } = parse(new SourceFile('<t>', 'to_int(.x) ?? 0'));
    const result = check(program);
    const stmt = program.statements[0]!;
    if (stmt.kind !== 'exprStatement') throw new Error('x');
    const call = stmt.expr.kind === 'binary' ? stmt.expr.left : stmt.expr;
    if (call.kind !== 'call') throw new Error('expected a call');
    expect(result.calls.get(call)?.signature.name).toBe('to_int');
  });
});

describe('checker: property — never throws on arbitrary well-formed-ish programs', () => {
  it('never throws when checking parser fuzz output', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const { program } = parse(new SourceFile('<fuzz>', text));
        expect(() => check(program)).not.toThrow();
      }),
    );
  });
});
