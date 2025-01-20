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
