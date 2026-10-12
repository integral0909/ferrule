# @ferrule/script

Ferrule Script, end to end: the lexer, parser, resolver/type checker, canonical formatter,
diagnostics renderer, optimizer, closure compiler, runtime, standard library, and inline test
runner. See `docs/language/design.md` (repository root) for the language design this implements,
and `docs/architecture.md` §5 for how it fits into the pipeline:

```
source text → lexer → parser → AST → resolver → type checker → optimizer → closure compiler
                                         │              │                        │
                                         └── diagnostics ┘             CompiledProgram.run(event)
                                          (spans, codes, fix hints)   → { continue | drop | abort }
```

Front end (lexer through type checker) and back end (optimizer through runtime/stdlib) are
separated by the `CheckResult` in `check/typedProgram.ts`: the front end never evaluates a
program, and the back end never re-derives a type or re-resolves a name — it walks `CheckResult`'s
`program` and reads `types`/`calls` for whatever a compiled node needs.

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

Compiling and running a program:

```ts
import { LogEvent } from '@ferrule/core';
import { compile, parseAndCheck } from '@ferrule/script';

const result = parseAndCheck(`
  .status = upcase(.status) ?? "unknown"
  if .status == "5XX" { .severity = "critical" }
`);
const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
  (d) => d.severity === 'error',
);
if (errors.length > 0) throw new Error('program has errors');

const program = compile(result); // optimizes by default; pass { optimize: false } to disable
const outcome = program.run(LogEvent.from({ status: 'ok' }));
// outcome: { kind: 'continue', events: [LogEvent] } | { kind: 'drop' } | { kind: 'abort', reason, span }
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
registry with every standard library function this milestone implements (see "Standard library
reference" below) — signatures only; pair it with `createDefaultImplementations()` (or your own
`ImplementationRegistry`) to run programs, not just check them. Pass a custom `FunctionRegistry` to
`check()` to check against a different (or extended) library.

## Compiler architecture

`compile(checkResult, options?): CompiledProgram` (`compile/program.ts`) turns a checked program
into a tree of pre-specialised JavaScript closures — never `eval`/`new Function`. It throws if
`checkResult.diagnostics` has any error-severity entry; compiling a program with unresolved errors
is a programming mistake, not something to recover from at compile time.

```ts
interface CompileOptions {
  implementations?: ImplementationRegistry; // default: createDefaultImplementations()
  optimize?: boolean; // default: true — see "Optimizer" below
  logsPerSecond?: number; // default: 100 — rate limit for the log() builtin
}

interface CompiledProgram {
  readonly slotCount: number; // Frame array size; exposed for diagnostics/benchmarking
  readonly tests: readonly TestDecl[]; // this program's `test { ... }` blocks, for runInlineTests
  run(event: LogEvent, options?: RunOptions): Outcome;
}

type Outcome =
  | { kind: 'continue'; events: readonly LogEvent[] } // events[0] is the (possibly mutated) input
  | { kind: 'drop' }
  | { kind: 'abort'; reason: string; span: Span };

interface RunOptions {
  limits?: Partial<ResourceLimits>;
  clock?: () => Timestamp; // for now()/log timing; default: the system clock
  onLog?: (entry: { level: string; message: Value; span: Span }) => void; // log(); default: no-op
}
```

**Frames instead of a second interpreter stack.** Ferrule Script has no recursion and no loops
(design.md §1), so the compiler assigns every `let`, `let mut`, `let v, err`, closure parameter,
and `match` object-pattern binding a fixed slot number at compile time (`compile/scope.ts`'s
`SlotAllocator`/`CompileScope`, mirroring the checker's own `Scope` nesting one-for-one but
tracking slots instead of types). `run` allocates one flat `Frame` (`RuntimeValue[]`) per call and
never resizes it — one array allocation per event, regardless of how many bindings or closures the
program has. A closure argument (`|k, v| ...`) compiles to a function that writes its parameters
into the _same_ frame at their assigned slots and evaluates its body there, so a closure invoked
once per element by `map_values`/`filter`/`map_keys` costs one small write per invocation, not a
new frame.

**Specialization by static type.** For every operator (`+ - * / % == != < <= > >= && || ??`,
unary `- !`, indexing, field access), `compile/compiler.ts` inspects `checkResult.typeOf(...)` for
the operands and, when both are statically the same concrete kind (`int`/`int`, `float`/`float`,
`string`/`string`), emits a closure that does exactly that one operation with no runtime kind
check — e.g. two `int` operands to `+` compile straight to `BigInt.asIntN(64, l(frame, ctx) +
r(frame, ctx))`. Only when an operand's static type is `any` (or a union) does the compiler fall
back to a runtime-dispatched path (`runtime/ops.ts`), which still avoids a second type-checking
pass by dispatching once on `typeof`. Path reads (`.a.b[0]`) compile against the AST's already-
segmented `PathSegment[]` directly (`@ferrule/core`'s `getPath`/`setPath`), not by re-parsing text.
Standard library _calls_, by contrast, go through one uniform ABI (see "Function implementation
interface" below) rather than a bespoke compiled form per function — the dominant cost of most
stdlib calls (regex matching, JSON parsing, hashing) swamps function-call dispatch overhead, so the
complexity of per-call-site specialization for the standard library was not worth it for this
milestone; only the _arguments_ to a call are specialised-compiled, the call itself is one
indirect call to a `BuiltinCall`.

**Fallibility: a sentinel value, not an exception.** Every expression the checker marks fallible
(`T!`) compiles to an `EvalFallible` closure — `(frame, ctx) => RuntimeValue | Failure` — where
`Failure` (`runtime/failure.ts`) is a plain class instance, never thrown. `??` and `!` and error
capture (`let v, err = ...`) each compile to a single `instanceof Failure` check. This is
deliberately not an exception: a `to_int`/index/`/` failure is common enough (e.g. inside a
`map_values`/`filter` closure run once per array element) that it sits on the hot path, and a
thrown-and-caught exception is measurably more expensive in V8 than a sentinel check — no stack
trace to build, no unwind, and the success path allocates nothing extra. For an expression the
checker proves _cannot_ fail, `compileHandled` simply re-types the same closure as `Eval` (`(frame,
ctx) => RuntimeValue`, no `Failure` in its return type) with zero runtime cost: this is safe
because every AST kind that can actually produce a `Failure` (calls, `/`/`%`, indexing) is marked
fallible by the checker whenever it can fail, so an unfallible-typed subtree never constructs one.
`assertValue` (used at the few points the compiler itself must convert an `EvalFallible` result it
statically knows succeeded, e.g. static-int `+`/`-`/`*`'s dynamic fallback path) turns an
unexpected `Failure` into a `ScriptBugError` rather than silently mistyping it as a `Value` — that
would indicate a compiler bug, not a program fault.

**Terminal control flow: one exception type.** `drop`, `abort`/`abort "reason"`, `!` applied to a
failed expression, and hitting a resource limit are rare, always end the run, and can originate
arbitrarily deep in nested closures — the opposite profile from ordinary fallibility. These use a
single `ScriptSignal` exception (`runtime/signal.ts`, discriminated by `signalKind: 'drop' |
'abort' | 'limit'`), thrown once and caught only at the top of `run`. Because a run throws at most
one of these and only when it is ending anyway, the cost of a JavaScript exception here is
irrelevant. Any _other_ exception escaping a standard library implementation (a genuine bug) is
also caught at that same boundary and turned into `{ kind: 'abort', reason: 'internal error: ...',
span, cause: 'internal' }` using `ctx.currentSpan` (updated at each statement and call boundary) —
a runtime error never escapes `run` as a raw exception, matching design.md §1 ("a program can
never crash the pipeline"). `outcomeForError` (`compile/program.ts`) is what maps `signalKind` (or
a `ScriptBugError`/other exception) to an abort `Outcome`'s `cause: 'abort' | 'limit' | 'internal'`
— a structured field callers should match on instead of inspecting `reason`'s text, which is for
humans and may change (it does, incidentally, still carry the historical `limit exceeded: `/
`internal error: ` prefixes for the `limit`/`internal` causes, but that's message content, not a
contract).

**`any`-typed operators that turn out to mismatch abort, they don't fail.** `+ - * == != < <= >

> = && ||`unary`- !`, and `if`/`&&`/`||`conditions are *not* marked fallible by the checker for`any`-typed operands (design.md's gradual-typing boundary: e.g. `1 + .amount`type-checks as
plain`int`, not `int!`, even though `.amount`might not be numeric at runtime, since a path with
no input schema is always`any`). The compiler cannot turn such a mismatch into a `Failure`without
violating that static contract, so instead it aborts the event with a descriptive reason — a safe
fallback consistent with design principle 1 ("every event gets an outcome"), and the one place a
type mismatch is a runtime concern rather than a checker one.`/`and`%`are the exception: the
checker *does* mark them fallible whenever either operand is`any`(since a division could fail
either from division-by-zero or a type mismatch), so those two report a`Failure`, not an abort.

**Path assignment and regex values.** `.a.b = expr` and `x.a[0] = expr` (a local variable's nested
field/index chain) both create intermediate objects/arrays as needed, mirroring `@ferrule/core`'s
`setPath` for event paths (`runtime/valuePath.ts`'s `setInValue` generalises the same semantics to
an arbitrary local value, since a local isn't required to already be an object the way the event
root is). `@ferrule/core`'s `Value` has no representation for a compiled regex (event _data_ never
contains one), so a `regex`-typed expression (`r/.../`, `compile_regex(...)`) compiles to a
`RegexValue` (`runtime/regex.ts`). `RuntimeValue` (`runtime/context.ts`) is a full superset of
`Value` — same shape, with `RegexValue` added as a leaf and, unlike `Value`, allowed _inside_ an
array or object, not just as a top-level scalar — which is what frames, array/object literals, and
`CallArgs` actually carry, so a script-local structure like `redact`'s `patterns: array<string |
regex>` argument (`[r/\d{16}/, "literal"]`) can freely hold one. Only the two places a value
actually _becomes event data_ — assigning to an event path, and `emit()` — reject a regex,
recursively through any array/object nesting, with an abort (`assertNoRegex`); `type_of`/`is_regex`
and `encode_json`/`sort` (which has no defined order for one) also check for a nested regex where
relevant (`containsRegex`). Assigning into a _local_ variable's nested field/index chain (`x.a[0] =
r/.../`) is the one place still narrower than a literal: it continues to reject a regex outright, a
minor asymmetry with array/object literals that is not expected to matter in practice.

### Optimizer

`optimizeProgram(program, checkResult, implementations)` (`compile/optimizer.ts`, run by `compile`
by default — pass `{ optimize: false }` to skip it) rewrites the checked AST bottom-up before
compilation:

- **Constant folding.** A call to a `pure` builtin with no closure/path-argument parameters, all of
  whose arguments are literals, is evaluated at compile time (using the _real_
  `FunctionImplementation.call`, so folding can never disagree with running the call normally) and
  replaced by its result — but only when the call succeeds. A call that would fail (`1 / 0`,
  `to_int("nope")`) is left as a real call, so its `Failure` still flows through `??`/`!`/error
  capture exactly as the unoptimized program would. The same rule applies to arithmetic/comparison/
  equality operators on two literal operands.
- **Dead-branch elimination.** An `if` whose condition is a literal `bool` (including one that
  itself just folded to a literal) is replaced by whichever branch always runs.
- **Dead `let` elimination.** A non-`mut` `let` the checker already flagged as unused (diagnostic
  `W503`) is dropped, but _only_ if its value is trivially side-effect-free after folding — a
  literal, a path/metadata-path read, or a plain variable read, never a call (which might have a
  resource-limit, `emit`, or `log` side effect that must still run even though its result is
  unused).

Because AST nodes the optimizer doesn't touch keep their original object identity, `checkResult`'s
`types`/`calls` maps (keyed by node identity) stay valid for them; nodes it _does_ rewrite are
either brand-new literals (which the compiler never looks up a type for) or calls, whose signature
resolution `optimizeProgram` re-keys into a fresh map it returns alongside the rewritten program
(`OptimizedProgram.calls`) — `compile/program.ts` passes that map to `new Compiler(checkResult,
implementations, calls)` instead of `checkResult.calls`. `test/compile/optimizer.test.ts` is a
property test asserting optimized and unoptimized compiles of the same program agree on every
generated input.

### Function implementation interface

Each standard library function pairs a `FunctionSignature` (front end: name, typed params, return
type, fallibility, purity, docs — unchanged from before this milestone) with a
`FunctionImplementation` (back end, `registry/implementation.ts`):

```ts
interface CallArgs {
  positional: readonly RuntimeValue[]; // every non-closure param, in declaration order
  named: ReadonlyMap<string, RuntimeValue>; // named-only args actually supplied
  closures: readonly CompiledClosure[]; // closure params, compiled, in declaration order
  positionalSupplied: readonly boolean[]; // false at an optional positional param not supplied
}
type CompiledClosure = (args: readonly RuntimeValue[], ctx: RunCtx) => RuntimeValue | Failure;
type BuiltinCall = (args: CallArgs, ctx: RunCtx, span: Span) => RuntimeValue | Failure;
interface FunctionImplementation {
  name: string;
  call: BuiltinCall;
}
```

The compiler evaluates a call's arguments itself — specializing _how_ each is evaluated using the
checker's static types the same way any other expression is compiled, and unwrapping `T!`
arguments before they reach here (a call is fallible only through its own `call` returning a
`Failure`, never through a propagated argument `Failure`) — then invokes `call` once with the
results. `del(.path)`/`exists(.path)` are the one exception: the checker requires their argument to
be a syntactic path (`requiresPathArgument` on the `FunctionParam`), so the compiler handles them
as intrinsics with direct access to the event, and they have no `ImplementationRegistry` entry at
all.

**Adding a new standard library function** (see any file under `stdlib/` for the pattern, e.g.
`stdlib/numbers.ts`): define its `FunctionSignature` and `FunctionImplementation` next to each
other in one `registerXxx(registry, impls?)` function (`impls` is optional so `createDefaultRegistry()`
can register every signature for type-checking-only callers without needing a runtime; pass one to
also register the implementation), using the `fn()`/`impl()`/`param()` builders. Return a `new
Failure("message")` for anything that can fail — never throw, except by calling the `runtime/
limits.ts` `checkXxx` helpers (which throw a `ScriptSignal` for a resource-limit violation; letting
that propagate is correct) or, for a function whose entire job is a control-flow effect like
`assert`, calling `abortSignal(...)` directly. Wire the new `registerXxx` into `stdlib/index.ts`'s
`registerStdlib`.

**Inferring a return type from a literal argument.** A `ReturnTypeRule` (`registry/signature.ts`)
can go beyond argument _types_: its `ClosureCallContext` carries an optional `argExprs` — the
actual argument _expression_ for each parameter, in declaration order — which the checker
(`check/checker.ts`) populates but nothing else needs to. `parse_regex` uses this to give its
result a precise, closed `object` type (one `string` field per named capture group) when its
`pattern` argument is a constant regex or string literal, by scanning the literal's text for
`(?<name>...)` groups at check time (`stdlib/parsing.ts`'s `parseRegexReturnType`) — falling back
to an open `object { ..any }` for a dynamic pattern, exactly like `map_values`/`filter` already
fall back to `any` when they can't determine a precise shape.

### Standard library reference

96 functions, all with an implementation. Every one has full `docs`/`examples` on its
`FunctionSignature` (see `registry.get(name).docs`); this table is a summary, not the reference —
`fallible` here is the function's own `Fallibility` (`registry/signature.ts`), independent of the
"wrong argument type also makes any call fallible" rule design.md §5 always applies on top.

**Type checks & coercion** (`stdlib/typeChecks.ts`, plus `to_int`/`to_string` in `stdlib/core.ts`)

| Function                                                                                                        | Fallible |                                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `is_null` `is_bool` `is_int` `is_float` `is_string` `is_bytes` `is_timestamp` `is_array` `is_object` `is_regex` | never    | true iff the value has that runtime kind                                  |
| `to_int` `to_float` `to_bool` `to_timestamp`                                                                    | always   | coerce from the closest compatible kinds (e.g. a numeric/RFC 3339 string) |
| `to_string`                                                                                                     | never    | a value's Ferrule Script literal form (`formatValue`)                     |
| `type_of`                                                                                                       | never    | the kind name as a string, e.g. `"int"`, `"array"`                        |

**Strings** (`stdlib/strings.ts`, plus `upcase`/`downcase`/`length` in `stdlib/core.ts`)

| Function                             | Fallible             |                                                                     |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------- |
| `upcase` `downcase`                  | on-argument-mismatch | case conversion                                                     |
| `trim` `trim_start` `trim_end`       | on-argument-mismatch | Unicode whitespace trimming                                         |
| `contains` `starts_with` `ends_with` | on-argument-mismatch | substring tests                                                     |
| `replace`                            | on-argument-mismatch | replace a literal-string or `regex` match, with an optional `count` |
| `split`                              | on-argument-mismatch | split on a literal string or `regex`, with an optional `limit`      |
| `join`                               | on-argument-mismatch | join `array<string>` with a separator                               |
| `slice`                              | on-argument-mismatch | UTF-16 code-unit substring, JS `slice` semantics                    |
| `pad_start` `pad_end`                | on-argument-mismatch | pad to a target width                                               |
| `truncate`                           | on-argument-mismatch | cut to a max length, appending a suffix                             |
| `strip_ansi`                         | on-argument-mismatch | remove ANSI/CSI escape sequences                                    |
| `format`                             | always               | `{}`/`{N}` placeholder substitution                                 |
| `repeat`                             | always               | repeat a string `count` times                                       |
| `length`                             | on-argument-mismatch | length of a string/bytes/array/object                               |

**Parsing** (`stdlib/parsing.ts`, plus `parse_json` in `stdlib/core.ts`)

| Function             | Fallible |                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse_json`         | always   | via `@ferrule/core`'s `parseJson`                                                                                                                                                                                                                                                                                                                          |
| `parse_regex`        | always   | matches `pattern` (`string`, compiled as regex source, or a `regex`) against `value` and returns its named capture groups as an object (each a `string`; `numeric_groups: true` also adds `"0"`/`"1"`/...); fails on no match. A constant pattern's named groups become the checker-inferred, closed result type — see "Function implementation interface" |
| `compile_regex`      | always   | compiles a string into a `regex` value (this is what `parse_regex` used to be, before it was redefined to match design.md's `parse_regex(value, pattern)` shape)                                                                                                                                                                                           |
| `matches`            | always   | true if `pattern` (`string` or `regex`) matches anywhere in `value`; named `matches`, not `match` (a reserved keyword)                                                                                                                                                                                                                                     |
| `parse_regex_all`    | always   | every match of a `pattern` (`string` or `regex`) in a string, with named groups                                                                                                                                                                                                                                                                            |
| `parse_key_value`    | always   | `k=v k2=v2` text into an object, with configurable separators/quoting                                                                                                                                                                                                                                                                                      |
| `parse_int`          | always   | arbitrary-radix (2-36) integer parsing                                                                                                                                                                                                                                                                                                                     |
| `parse_float`        | always   | strict (no partial-parse) float literal parsing                                                                                                                                                                                                                                                                                                            |
| `parse_timestamp`    | always   | RFC 3339, or a strftime-style `format`                                                                                                                                                                                                                                                                                                                     |
| `parse_duration`     | always   | `"1h30m"`-style text to nanoseconds, via `@ferrule/core`'s `parseDuration`                                                                                                                                                                                                                                                                                 |
| `parse_url`          | always   | scheme/host/port/path/query/fragment/username/password                                                                                                                                                                                                                                                                                                     |
| `parse_query_string` | always   | query string to an object (repeated keys become an array)                                                                                                                                                                                                                                                                                                  |

A `string` pattern means different things in different functions, each documented on the function
itself: for `parse_regex`/`parse_regex_all`/`matches`/`redact` it is regex _source text_, compiled
once and cached by `(pattern, flags)` text (`runtime/regexCache.ts`, bounded at 256 entries,
evicting the least-recently-used) so a call site that always passes the same literal pays
compilation cost once, not per event; for `replace`/`split` a `string` pattern is instead a
_literal_ substring (never a regex) — see those functions' own docs.

**Redaction** (`stdlib/redact.ts`)

| Function    | Fallible |                                                                                     |
| ----------- | -------- | ----------------------------------------------------------------------------------- |
| `redact_ip` | always   | zero IPv4/IPv6 address bits beyond a `keep_prefix` bit count (e.g. a `/24`)         |
| `redact`    | always   | replace every match of each of several `string`/`regex` patterns with a placeholder |
| `mask`      | always   | blank out the middle of a string, keeping a prefix/suffix (e.g. `"****1111"`)       |

**Encoding** (`stdlib/encoding.ts`)

| Function                            | Fallible                      |                                                       |
| ----------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `encode_json`                       | always                        | via `@ferrule/core`'s `encodeJson`, optional `pretty` |
| `encode_base64` / `decode_base64`   | on-argument-mismatch / always | optional `url_safe` alphabet                          |
| `encode_hex` / `decode_hex`         | on-argument-mismatch / always |                                                       |
| `encode_percent` / `decode_percent` | always / always               | `encodeURIComponent`/`encodeURI`-style, or decode     |

**Numbers & time** (`stdlib/numbers.ts`, plus `now` in `stdlib/core.ts`)

| Function             | Fallible             |                                                                          |
| -------------------- | -------------------- | ------------------------------------------------------------------------ |
| `abs` `floor` `ceil` | on-argument-mismatch |                                                                          |
| `round`              | on-argument-mismatch | optional decimal `precision`                                             |
| `min` `max`          | never                | by natural order (`@ferrule/core`'s `compareValues`)                     |
| `mod`                | always               | matches the `%` operator                                                 |
| `now`                | never (impure)       | the run's clock                                                          |
| `format_timestamp`   | never                | strftime-style subset: `%Y %y %m %d %H %M %S %L %f %z %a %A %b %B %j %%` |
| `to_unix_timestamp`  | always               | `unit`: `"s"`/`"ms"`/`"us"`/`"ns"`                                       |

**Collections** (`stdlib/collections.ts`, plus `length`/`map_values`/`filter` in `stdlib/core.ts`)

| Function                     | Fallible                      |                                                                                       |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `length`                     | on-argument-mismatch          | of a string/bytes/array/object                                                        |
| `keys` `values`              | on-argument-mismatch          | an object's fields, insertion order                                                   |
| `get` `set`                  | always                        | runtime path-array (`["a", 0, "b"]`) read/write                                       |
| `del(.path)` `exists(.path)` | never                         | compiler intrinsics on the _syntactic_ event path — no `ImplementationRegistry` entry |
| `merge`                      | always                        | shallow, or `deep: true` (recursive on both-object fields)                            |
| `compact`                    | on-argument-mismatch          | drop `null`/empty elements or fields                                                  |
| `flatten` `unflatten`        | always                        | nested object ⇄ dotted-key flat object                                                |
| `map_values` `map_keys`      | on-argument-mismatch / always | closure over every field's value / key                                                |
| `filter`                     | on-argument-mismatch          | closure keeps elements returning `true`                                               |
| `includes` `unique`          | on-argument-mismatch          | structural equality (`runtimeEquals`)                                                 |
| `append` `push`              | on-argument-mismatch          | concatenate / append one element (returns a new array)                                |
| `sort`                       | always                        | by natural order, ascending or `descending`                                           |
| `chunks` `zip`               | always / on-argument-mismatch | split into fixed-size chunks / pair two arrays                                        |

**Hashing & IDs** (`stdlib/hashing.ts`)

| Function              | Fallible             |                                             |
| --------------------- | -------------------- | ------------------------------------------- |
| `sha1` `sha256` `md5` | on-argument-mismatch | lowercase hex digest (not for security use) |
| `hmac`                | always               | keyed digest, `algorithm` named param       |
| `uuid_v4`             | never (impure)       | `node:crypto`'s `randomUUID`                |
| `uuid_v7`             | never (impure)       | hand-built per RFC 9562 §5.7: time-sortable |

**Misc** (`stdlib/misc.ts`, plus `emit` in `stdlib/core.ts`)

| Function | Fallible       |                                                |
| -------- | -------------- | ---------------------------------------------- |
| `assert` | never (impure) | aborts the event unless a condition holds      |
| `log`    | never (impure) | rate-limited debug line via `RunOptions.onLog` |
| `emit`   | never (impure) | an extra event alongside this one              |

### Resource limits

Enforced per event (design.md §6), each ending the run with `{ kind: 'abort', reason: 'limit
exceeded: ...', span }` — a distinct, greppable reason prefix, not a separate `Outcome` variant:

| Limit                 | Default   | Checked by                                                      |
| --------------------- | --------- | --------------------------------------------------------------- |
| `maxStringLength`     | 1,000,000 | string concatenation, interpolation, and stdlib string builders |
| `maxCollectionSize`   | 100,000   | array/object literals and stdlib collection builders            |
| `maxRegexInputLength` | 1,000,000 | the subject string of a regex match/replace/split/search        |
| `maxEmittedEvents`    | 64        | `emit()`, beyond the (possibly dropped) input event             |

Override any of them per call via `program.run(event, { limits: { maxStringLength: 4096 } })`
(`RunOptions.limits` is a `Partial<ResourceLimits>`, merged over the defaults).

### Execution model: logs directly, metrics through a view, spans not yet

`CompiledProgram.run` itself still accepts only a `LogEvent` — `MetricEvent`/`SpanEvent` are a
compile-time (TypeScript) type error at the call site, not a runtime check. The standard library
(path reads/writes, `is_*`, string/collection functions, ...) is built entirely around `LogEvent`'s
`fields: ValueMap`; a metric or span event has a structured, typed shape instead (`MetricValue`,
`SpanKind`, attributes, ...) that would want first-class accessors of its own — a substantial
enough design surface, matching design.md's "small surface, rich library" principle, that bolting
it onto the compiler directly was not worth it.

A **metric** event gets that accessor story a layer up instead: `metric/schema.ts`'s
`metricEventSchema()` is an `inputSchema` (paired with `validateWrites: true` and
`metricReadonlyPaths()`) that types `.name`, `.namespace`, `.tags`, `.kind`, `.value_type`, and
every value-type's own field(s) (`.value`, `.values`, `.samples`/`.statistic`,
`.buckets`/`.count`/`.sum`, `.quantiles`/`.count`/`.sum`) — see `docs/language/design.md`'s
"Metric events" for the full shape — and `metric/view.ts`'s `metricEventToView`/
`applyViewToMetric` build the `LogEvent`-shaped view a compiled program actually runs against and
convert the result back into the real `MetricEvent`, fully re-validated (not just type-checked:
see that section's "every other field's write is _also_ validated" paragraph). `script`'s
`metrics: true` option (`packages/operators/src/script.ts`) is the pipeline-facing wrapper around
this. A **span** event has no such view yet; a caller that needs to run a Ferrule Script transform
on spans today should convert them to a `LogEvent` representation first (or wait for a future
milestone) — there is no supported way to do it through this package.

### Inline tests

`runInlineTests(program: CompiledProgram): readonly InlineTestResult[]` (`compile/testRunner.ts`)
runs every `test "name" { given { ... } expect { ... } }` block a program's source contains
(design.md §7):

```ts
interface InlineTestResult {
  name: string;
  passed: boolean;
  diffs: readonly { path: string; expected: Value; actual: Value | undefined }[];
  outcome: Outcome; // the full outcome of running the transform on `given`
}
```

For each test block, `given`/`expect` are evaluated standalone (a fresh frame with none of the
transform's own `let`s in scope — every example in design.md and the checker's own fixtures write
them as plain object literals, and this is enough to also use literals, arrays/objects, string
interpolation, and pure builtin calls like `now()`; a _transform-level_ variable reference inside
`given`/`expect` is a known gap, below). `given` becomes a fresh event's fields; the whole program
then runs on it via the normal `program.run(...)`. Comparison is a **partial match**: every field
`expect` names must equal the corresponding field of the resulting event; fields `expect` doesn't
mention are ignored (so a test only needs to state what it cares about) — if the run didn't
`continue` (it dropped or aborted instead), the test fails and `outcome` says why. This powers
`ferrule test` in a later milestone.

### Benchmark

`bench/throughput.ts` measures events/sec for a representative program (field normalization,
`map_values`/`filter` closures, `if`/`match`), comparing optimized vs. unoptimized compiles and a
trivial one-statement program (to isolate fixed per-event overhead from stdlib call cost). Not part
of CI. Run it with:

```
node --experimental-strip-types packages/script/bench/throughput.ts
```

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
- **No overflow/precision diagnostics for arithmetic.** `int` arithmetic is checked for kind
  (`int`/`float` never mix) but int64 wraparound and float precision loss are runtime behaviour,
  not something the checker flags.
- **`given`/`expect` in a `test` block cannot reference the transform's own `let`-bound
  variables.** They are evaluated standalone against a fresh frame (see "Inline tests" above), so
  they support literals, nested arrays/objects, string interpolation, and pure builtin calls, but
  not a name the transform itself declared with `let`. Every example in design.md and the
  checker's own fixtures write `given`/`expect` as plain object literals, which this fully
  supports; the general case would need running the transform's own statements up to the test's
  source position first, which is a natural `ferrule test` CLI milestone extension.
- **`test` blocks only assert a `continue` outcome's fields, not `drop`/`abort`.** The grammar's
  `expect` is an object literal (design.md §7 doesn't define a `drop`/`abort` expectation form);
  `runInlineTests` still reports the full `Outcome` on a test whose transform dropped or aborted
  the event (so a test against a drop/abort-expected input fails loudly and visibly, with the
  outcome attached, rather than silently), but there's no syntax yet to _assert_ a drop/abort is
  the expected, passing behaviour. A minimal grammar extension (e.g. `expect drop` / `expect abort
"reason"`) is a natural follow-up.
- **A metadata path (`%unknown_name`) that isn't `%source_id`/`%source_type`/`%received_at` reads
  as `null` rather than a checker error.** The checker doesn't validate metadata path names against
  a known set (`checkExprInner`'s `'metadataPath'` case always returns `any`, unconditionally); the
  compiler mirrors that permissiveness at the value level instead of erroring.
- **The standard library's call ABI does not specialize per call site beyond compiling its
  arguments** (see "Compiler architecture" above for the reasoning) — only language operators
  (arithmetic, comparisons, path/field/index access) get the full per-call-site specialization
  design.md calls for.
- **`regex`-typed values cannot be stored in event data** — only in a script-local `let`, array,
  object, or function argument (see "Compiler architecture" above). This is a consequence of
  `@ferrule/core`'s `Value` model having no regex representation, not a language-design choice;
  assigning one to an event path or `emit()`-ing it aborts the event with a clear reason rather
  than silently coercing or crashing. Assigning into a _local_ variable's nested field/index chain
  (`x.a[0] = r/.../`) is narrower still and also rejects a regex, unlike an array/object literal —
  a minor, documented asymmetry (`compile/compiler.ts`'s `compileAssignTarget`).
- **`match` (the boolean regex-test function) is named `matches`.** `match` itself is a reserved
  keyword in Ferrule Script's grammar (`match subject { pattern => expr, ... }`), so a stdlib
  function cannot be named `match` — the parser cannot tell `match(x)` (a call) apart from `match
(x) { ... }` (a match expression with a parenthesized subject) without deeper lookahead than the
  rest of the grammar needs. `matches(value, pattern)` is the closest available name.
- **`CompiledProgram.run` itself accepts only `LogEvent`; a metric event goes through a view, and
  a span event has no view at all yet** — see "Execution model" above.
- **The metric view's per-value-type fields are typed together, not narrowed to the event's actual
  type.** `.value`, `.buckets`, `.quantiles`, etc. are all precisely typed regardless of
  `.value_type`, so reading or writing one that does not apply reads back `null`/has no effect
  rather than being a compile-time error — declaring the metric's specific value type up front
  (and narrowing the view to just its fields) is a natural, currently unimplemented follow-up; see
  `metric/schema.ts`'s module doc.
- **Changing a metric's value type is not supported.** `.value_type` is read-only
  (`metricReadonlyPaths`); there is no way to turn a counter into a histogram from inside a
  program. Route the event through a different series or a separate derivation step instead.
