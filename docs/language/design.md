# Ferrule Script — language design

Status: **draft**. This document fixes the design the M1/M2 implementation targets. The
normative specification (grammar, typing rules, standard library reference) will be generated
alongside the implementation and live next to this file.

## 1. Design principles

1. **Every event gets an outcome.** A program either finishes (the event continues), `drop`s
   the event (counted, silent), or `abort`s (the event goes to the component's error output
   with a reason). A program can never crash the pipeline or silently lose an event.
2. **Failure is visible in types.** Operations that can fail on some inputs (parsing,
   coercion, regex matching, division) are _fallible_. The checker rejects a program that uses
   a fallible result without handling it.
3. **Total and bounded.** No loops, no recursion, no user-defined functions that call
   themselves. Iteration uses bounded higher-order functions (`map_values`, `filter`,
   `for_each`) over finite collections. Every program terminates, and its cost is roughly
   proportional to the size of the event.
4. **Paths are first-class.** `.foo.bar[0]` reads and writes event fields directly. The event
   is the implicit subject of every program.
5. **Small surface, rich library.** The syntax stays small; capability comes from the standard
   library.

## 2. Lexical structure

| Token         | Examples                                       |
| ------------- | ---------------------------------------------- |
| Comment       | `# to end of line`                             |
| Identifier    | `status`, `_tmp`, `http_code2`                 |
| Integer       | `42`, `-7`, `1_000_000`, `0x1F`, `0b1010`      |
| Float         | `3.14`, `1e-3`, `2.0`                          |
| String        | `"line\n"` (escapes, `{{ interpolation }}`)    |
| Raw string    | `r'no \escapes here'`                          |
| Byte string   | `b"\x00\xff"`                                  |
| Timestamp     | `t'2026-01-01T00:00:00Z'`                      |
| Regex         | `r/^\d+$/i`                                    |
| Path          | `.`, `.message`, `.a.b[2]`, `."key.with.dots"` |
| Metadata path | `%source_id`, `%received_at`                   |

Newlines terminate statements; `;` may also be used.

## 3. Types

```
type    = null | bool | int | float | string | bytes | timestamp | regex
        | array<type> | object { field: type, ... , ..rest? } | type "|" type | any
```

- `int` is a signed 64-bit integer; overflow wraps. `float` is an IEEE-754 double. They are
  never implicitly converted: `1 + 1.5` is a type error; `to_float(1) + 1.5` is fine.
- Event fields read through paths have type `any` unless an input schema is declared for
  the component, in which case paths are typed from the schema.
- Types narrow through control flow:

  ```ferrule
  if is_string(.status) {
    .status = upcase(.status)   # .status: string here
  }
  ```

## 4. Expressions and statements

| Construct                          | Meaning                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `.a = expr`                        | Assign to a field (creates intermediate objects/arrays)      |
| `let x = expr`                     | Bind a local variable (immutable)                            |
| `x = expr`                         | Reassign a variable declared with `let mut`                  |
| `del(.a)`                          | Remove a field; returns the removed value                    |
| `if c { } else if c { } else { }`  | Conditional; is an expression, yields the last value         |
| `match v { pattern => expr, ... }` | Pattern match on kind, literal, regex, or object shape       |
| `expr ?? fallback`                 | Use `fallback` if `expr` fails or is `null`                  |
| `expr!`                            | Abort the event if `expr` fails                              |
| `let v, err = expr`                | Capture failure: `err` is a string or `null`                 |
| `drop`                             | Discard the event                                            |
| `abort` / `abort "reason"`         | Route the event to the error output                          |
| `emit(expr)`                       | Emit an additional event (for splitting one event into many) |

Operators, lowest to highest precedence:

```
??                      (left)
||                      (left)
&&                      (left)
== != < <= > >=         (non-associative)
+ -                     (left)
* / %                   (left)
! -  (unary)
. [ ] ( ) !  (postfix)
```

`/` on integers is fallible (division by zero); `%` likewise.

## 5. Fallibility

Every expression is typed as `T` or `T!` (fallible `T`). Rules:

- A standard-library function declares which of its parameters and results are fallible.
  `to_int(any) -> int!`, `upcase(string) -> string`.
- Passing a value of the wrong type to a function makes the call fallible, even if the function
  itself is not: `upcase(.message)` is `string!` when `.message: any`.
- A `T!` expression cannot be assigned, passed as an argument, or used in an operator until it
  is handled with `??`, `!`, or error capture.
- Handling removes the `!`: `to_int(.code) ?? 0` has type `int`.

The checker reports an unhandled fallible expression as an error with a fix suggestion that
shows each of the three handling forms.

## 6. Execution model

A program runs once per event. It receives the event as a mutable object and may read metadata
through `%` paths. Programs are compiled to JavaScript closures, specialised by the static types
of their operands. Nothing is evaluated from strings at runtime, and regex literals are compiled
once at load time.

Resource limits apply per event: maximum emitted events, maximum string length produced by
concatenation, and maximum collection size produced by library functions. Hitting a limit aborts
the event with a distinct reason.

## 7. Inline tests

Programs can carry tests that `ferrule test` runs:

```ferrule
.level = downcase(.level) ?? "info"

test "normalises level" {
  given { "level": "WARN" }
  expect { "level": "warn" }
}
```

## 8. Metric events

Everything above describes a program's view of a **log** event: `.field` paths over an open,
mostly-`any` object (§3). A **metric** event (`@ferrule/core`'s `MetricEvent`) has a different,
fixed shape instead — a name, a namespace, a set of string tags, an incremental/absolute kind, and
a value whose structure depends on the metric's type (counter, gauge, set, distribution,
histogram, or summary). The `script` component's `event_kind: metric` option checks and runs a
program against this view instead of a log's; see `packages/operators/src/script.ts`.

| Path             | Type                                                 | Present for        |
| ---------------- | ---------------------------------------------------- | ------------------ |
| `.name`          | `string`                                             | every metric       |
| `.namespace`     | `string \| null`                                     | every metric       |
| `.tags`          | `object { ..string }`                                | every metric       |
| `.kind`          | `string` (`"incremental"` or `"absolute"`)           | every metric       |
| `.value_type`    | `string`, **read-only**                              | every metric       |
| `.timestamp`     | `timestamp \| null`                                  | every metric       |
| `.interval_ms`   | `float \| null`                                      | every metric       |
| `.value`         | `float`                                              | counter, gauge     |
| `.values`        | `array<string>`                                      | set                |
| `.statistic`     | `string` (`"histogram"` or `"summary"`)              | distribution       |
| `.samples`       | `array<object { value: float, rate: float }>`        | distribution       |
| `.buckets`       | `array<object { upper_limit: float, count: float }>` | histogram          |
| `.count`, `.sum` | `float`                                              | histogram, summary |
| `.quantiles`     | `array<object { quantile: float, value: float }>`    | summary            |

Every value-type's field(s) coexist in this one view and are typed and readable regardless of the
event's actual type — a field that does not apply to the current event reads as `null`, the same
as any other absent path. `.tags`, by contrast, is always precisely typed: any tag _name_ is
allowed, but a tag's _value_ must be a string, so `.tags.env = 1` is a compile-time type error —
not just for a declared tag, any tag name type-checks the same way, since `.tags` has no fixed set
of field names, only a fixed value type:

```ferrule-metric
.tags.region = "eu"
if .value_type == "counter" || .value_type == "gauge" {
  .value = .value + 1.0
}
```

```ferrule-metric-error
.tags.env = 1
```

`.value_type` cannot be assigned at all — changing a metric's value type (turning a counter into a
histogram, say) isn't supported, so reassigning it is rejected at compile time rather than
producing a metric whose fields don't match its own declared type:

```ferrule-metric-error
.value_type = "gauge"
```

Every other field's write is _also_ validated once the program finishes running, not just
type-checked: this is deliberately not fully sound at the type level (an open `rest`/`any` type
along the way, e.g. through `merge`, isn't checked — the same gradual-typing tradeoff §3's
`input_schema` already makes for logs), so a non-string tag value that slipped past the checker, a
`.kind` that isn't `"incremental"`/`"absolute"`, or a deleted required field each abort the event
with a clear reason instead of silently producing a malformed metric. A field that doesn't apply
to the event's actual type (writing `.buckets` on a counter, say) is simply never read back — it
has nowhere to go, so the write has no effect on the metric that leaves the component, but it does
not abort the event either.

A program that reads and writes none of these fields leaves the metric's value bit-identical, for
every one of the six value types.

## 9. Span events

A **span** event (`@ferrule/core`'s `SpanEvent`) is one span of a distributed trace: an
identified, timed operation with a status, attributes, a resource, and a record of what happened
during it (annotations, links to other spans). Like the metric view (§8), the span view is flat —
every field below is a top-level `.path`, not reached through a chain mirroring `SpanEvent`'s own
shape. The `script` component's `event_kind: span` option checks and runs a program against this
view; `filter`/`route`'s `event_kind: span` and `tail_sampling`'s `script` policy type check a
_condition_ (a single expression, not a full program) against it instead — see
`packages/operators/src/script.ts`, `filter.ts`, `route.ts`, and `tail_sampling.ts`.

| Path              | Type                                                                                                             | Read-only |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| `.trace_id`       | `string` (hex)                                                                                                   | yes       |
| `.span_id`        | `string` (hex)                                                                                                   | yes       |
| `.parent_span_id` | `string \| null` (hex)                                                                                           | yes       |
| `.trace_state`    | `string \| null`                                                                                                 |           |
| `.name`           | `string`                                                                                                         |           |
| `.kind`           | `string` (`"unspecified"`/`"internal"`/`"server"`/`"client"`/`"producer"`/`"consumer"`)                          |           |
| `.start_time`     | `timestamp`                                                                                                      |           |
| `.end_time`       | `timestamp`                                                                                                      |           |
| `.duration`       | `int` (nanoseconds), derived from `.start_time`/`.end_time`                                                      | yes       |
| `.status`         | `object { code: string, message: string \| null }`                                                               |           |
| `.attributes`     | `object { ..any }`                                                                                               |           |
| `.resource`       | `object { ..any }`                                                                                               |           |
| `.annotations`    | `array<object { name: string, time: timestamp, attributes: object { ..any } }>`                                  | yes       |
| `.links`          | `array<object { trace_id: string, span_id: string, trace_state: string \| null, attributes: object { ..any } }>` | yes       |

Trace/span identifiers are hex strings, matching `SpanEvent.traceIdHex`/`spanIdHex`; they, the
derived `.duration`, and `.annotations`/`.links` (a record of what already happened) are
read-only — a program can branch on them but never rewrite them. The checker rejects a write
through _any_ path starting with a read-only field, not just a bare reassignment, so
`.annotations[0].name = "x"` is a compile-time error exactly like `.annotations = []`:

```ferrule-span-error
.annotations = []
```

```ferrule-span-error
.duration = 0
```

`.attributes`/`.resource` are open objects — any key, any value an OTLP attribute can hold (a
null, bool, int, float, string, byte string, timestamp, or an array/object nesting the same) —
and `.status.code` is validated to be `"unset"`, `"ok"`, or `"error"` once the program finishes
running, the same "checker is best-effort, write-back is the real enforcement" split §8 already
documents for a metric's `.tags`/`.kind`:

```ferrule-span
if .attributes.http_route == "/healthz" {
  drop
}
.status.code = "ok"
```

A program that reads and writes none of these fields leaves the span bit-identical. `.scope` (the
span's `InstrumentationScope`) is not exposed in this view, a documented, currently unimplemented
follow-up alongside §8's "not narrowed to `.value_type`" gap.
