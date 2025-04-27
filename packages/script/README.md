# @ferrule/script

The front end for Ferrule Script: the lexer, parser, resolver/type checker, canonical formatter,
and diagnostics renderer. See `docs/language/design.md` (repository root) for the language design
this implements, and `docs/architecture.md` §5 for how it fits into the pipeline:

```
source text → lexer → parser → AST → resolver → type checker  →  diagnostics (CLI / LSP)
                                                        │
                                        typed program representation
                                                        │
                                          (a later milestone's compiler)
```

This package covers everything up to and including the type checker. It does not evaluate
programs: there is no interpreter and no compiler here (design.md's "compile, don't interpret" and
the optimizer/closure compiler are later milestones), and the standard library is declared only as
_signatures_ (`registry/`) — enough to type-check calls to `to_int`, `upcase`, `map_values`, and so
on, with no runtime implementation behind them yet.

Node.js standard library only — no runtime dependencies beyond `@ferrule/core`.

## Quick start

```ts
import { check, format, parse, renderDiagnostics, SourceFile } from '@ferrule/script';

const source = `
.status = upcase(.status) ?? "unknown"

if is_string(.level) {
  .level = downcase(.level)
}
`;

const file = new SourceFile('pipeline.fer', source);
const { program, diagnostics: parseDiagnostics } = parse(file);
const { diagnostics: checkDiagnostics, types } = check(program);

const diagnostics = [...parseDiagnostics, ...checkDiagnostics];
if (diagnostics.length > 0) {
  console.log(renderDiagnostics(diagnostics, file, { color: true }));
}

console.log(format(source)); // canonical formatting, comments preserved
```

## Public API

### Parsing and checking

- `parse(source: string | SourceFile, name?: string): ParseResult` — `{ program, diagnostics }`.
  Never throws: a malformed program still returns a best-effort `Program` (built with error
  recovery) plus one diagnostic per problem found.
- `check(program: Program, options?: CheckOptions): CheckResult` — resolves scopes, checks types
  and fallibility, and narrows types through `if`/`match`. `CheckOptions` is
  `{ registry?: FunctionRegistry; inputSchema?: Type }`; `inputSchema` types `.field` paths from a
  declared event shape (default: every path is `any`, per design.md §3).
- `parseAndCheck(source, options?)` — both in one call.
- `format(source: string): string` — canonical formatting. Idempotent
  (`format(format(x)) === format(x)`), and parsing the output yields a program equivalent to
  parsing the input. Comments are preserved where the grammar has somewhere to attach them
  (before a statement/object field/match arm, and trailing on the same line); a comment in the
  middle of an expression has no such anchor and is dropped without error.
- `renderDiagnostics(diagnostics, source, options?)` / `renderDiagnostic(...)` — rustc-style
  snippets with line numbers and carets (`options.color` for ANSI). `summarizeDiagnostic(...)`
  gives a one-line `file:line:col: severity[code]: message` form.
- `explainCode(code)` / `DIAGNOSTIC_CATALOG` — every diagnostic code's summary and explanation,
  for `ferrule explain <code>` in the CLI milestone.

### The typed program representation

`CheckResult` is what a later compiler milestone consumes:

```ts
interface CheckResult {
  program: Program; // the same AST `parse` produced
  diagnostics: readonly Diagnostic[];
  types: ReadonlyMap<Expr, ExprType>; // every expression's resolved type + fallibility
  calls: ReadonlyMap<CallExpr, ResolvedCall>; // every call's resolved FunctionSignature
  typeOf(expr: Expr): ExprType; // types.get(expr), defaulting to `any`
}
```

Rather than a second tree that mirrors the AST node-for-node, types and call resolutions are
attached _out of band_, keyed by AST node identity. A compiler walks `result.program` exactly like
the parser's AST (same shapes, same spans) and calls `result.typeOf(node)` wherever a pass needs
the type Ferrule Script inferred, or `result.calls.get(node)` to get the `FunctionSignature` a call
resolved to without repeating name/overload resolution.

### Types

`Type` is a plain discriminated union (`{ kind: 'int' }`, `{ kind: 'array', element }`, `{ kind:
'object', fields, rest }`, `{ kind: 'union', members }`, plus `null`/`bool`/`float`/`string`/
`bytes`/`timestamp`/`regex`/`any`/`never`). Constructors: `nullType` … `neverType`, `arrayType`,
`objectType(fields, rest?)`, `unionType(members)` (normalizes: flattens, dedups, drops `never`,
collapses to `any`). Operations: `isSubtype`, `joinTypes`, `meetTypes`, `subtractType`,
`typesEqual`, `formatType`. `ExprType` pairs a `Type` with `fallible: boolean` — design.md §5's
`T`/`T!` — via `handled(type)` / `fallibleOf(type)` / `formatExprType`.

### Standard library signatures

`FunctionRegistry` holds `FunctionSignature`s (name, typed params with optional/named-only/closure
markers, a return type or a `(argTypes, ctx) => Type` rule for dependently-typed builtins like
`map_values`, a `Fallibility`, purity, docs, examples). `createDefaultRegistry()` returns a
registry with the functions this milestone's checker tests exercise: `to_int`, `to_string`,
`upcase`, `downcase`, `parse_json`, `parse_regex`, `is_string`, `is_int`, `length`, `del`,
`exists`, `map_values`, `filter`, `now`, `emit` — signatures only; a later stdlib milestone
implements them. Pass a custom `FunctionRegistry` to `check()` to check against a different (or
extended) library.

### Syntax

`SourceFile` (name, text, `lineColumnAt`/`lineText`/etc.), `Span` (`{ start, end }`, half-open UTF-
16 offsets), `lex(source, range?)` (never throws; malformed input becomes `error` tokens plus
diagnostics), and the full `Expr`/`Statement`/`Pattern` AST types, all exported for tooling (an
LSP or CLI built on this package).

## Design notes

- **Two lexical disambiguations are resolved by "what ended the previous token."** `.` after
  something that completes an expression (an identifier, `)`, a literal, …) is postfix field
  access; anywhere else it starts a path literal (`.a.b[0]`). `%` after an expression-completing
  token is the modulo operator; anywhere else it starts a metadata path (`%source_id`). Both use
  the same `lastSignificantKind` tracked by the lexer — see `syntax/lexer.ts`.
- **`{` is ambiguous between an object literal and a block** (`{ "a": 1 }` vs. `{ stmt; stmt }`).
  The parser resolves it by looking past any newline for `key:` (see
  `Parser.looksLikeObjectLiteral`); `if`/`match`/`closure` bodies never hit this path because the
  grammar already knows they're blocks.
- **Argument-mismatch fallibility needs `any` to _not_ be bidirectionally compatible.** `isSubtype`
  treats `any` as compatible with everything (the usual gradual-typing escape hatch), but
  design.md's `upcase(.message)` example requires an `any`-typed argument against a concrete
  parameter to count as a possible mismatch. The checker uses a separate `isGuaranteedMatch`
  (argument-side `any` is never guaranteed) for exactly this rule, and a matching `isExhaustive`
  for `match` coverage, so `match .v { string => ... }` without a wildcard is correctly flagged
  non-exhaustive even though `.v : any`.
- **Flow narrowing covers `if is_string(x)`, `x is string`, `&&`-chains of either, and `match`
  kind-pattern arms**, for both local variables and paths (keyed by a canonical
  `id:name`/`path:[...]` string). It does not cover `||`, negation (`!is_string(x)`), or narrowing
  that survives past the branch — each `if`'s narrowing is pushed before checking a branch and
  popped after, per `Checker.withNarrowings`.

## Known limitations

- **The formatter has no line-width-aware wrapping.** Long expressions print on one line
  regardless of width; only constructs that are always multi-line by convention (blocks, object
  literals, `match`, `test`) span multiple lines. A future version could add Wadler-style
  document-based printing.
- **Comments only survive at statement/object-field/match-arm boundaries.** A comment written
  between call arguments, inside a binary expression, or between array elements is accepted (the
  parser does not error on it) but dropped by the formatter, since the AST has no attachment point
  there.
- **Object-shape subtyping is structural but not fully sound for `.` writes.** Reading `.a.b` from
  an input schema is precise; writing `.a.b = x` never checks against the schema (paths always
  accept a write), matching the language's "paths create intermediate structure" semantics rather
  than a closed record type.
- **`test { given / expect }` blocks are type-checked but not executed.** The checker confirms
  they are well-typed object literals and, when an `inputSchema` is given, that each field's value
  matches the schema's declared type for it (fields the schema doesn't mention are left alone, so
  a `given`/`expect` block may be partial). Actually running the program against `given` and
  comparing the result to `expect` is `ferrule test`'s job, in a later milestone.
- **No overflow/precision diagnostics for arithmetic.** `int` arithmetic is checked for kind
  (`int`/`float` never mix) but int64 wraparound and float precision loss are runtime behaviour,
  not something the checker flags.
