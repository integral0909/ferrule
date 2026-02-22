import type { Value } from '@ferrule/core';
import type { Span } from '../syntax/source.js';
import type { RuntimeValue } from './context.js';
import { abortSignal } from './signal.js';

/**
 * A compiled regex, the runtime representation of Ferrule Script's `regex` type.
 *
 * `@ferrule/core`'s `Value` has no variant for a regular expression (event *data* — what actually
 * flows through a pipeline — never contains one), so a regex cannot be a `Value`. It is however a
 * real Ferrule Script type (`regex`, design.md §3): a regex literal or a `compile_regex()` result
 * can be bound with `let` and passed to functions like `replace`/`split`/`parse_regex_all` that
 * take a `regex` argument. `RuntimeValue` (`runtime/context.ts`) is the superset of `Value` — with
 * `RegexValue` added, and (unlike `Value`) allowed inside arrays/objects too — that the compiler
 * actually threads through frames and call arguments; the two places event data is actually
 * constructed (assigning to an event path, and `emit()`) reject a regex, recursively, with an
 * abort via {@link assertNoRegex} rather than letting one silently become "data" that
 * `@ferrule/core` cannot represent.
 */
export class RegexValue {
  constructor(
    readonly regex: RegExp,
    readonly source: string,
    readonly flags: string,
  ) {}
}

export function isRegexValue(value: unknown): value is RegexValue {
  return value instanceof RegexValue;
}

/**
 * Depth cap for the recursive walks below: bounds stack usage against a pathologically deep *or*
 * cyclic structure (a script value can never legitimately be cyclic, but nothing stops a bug from
 * producing one, and a walk that just increments a counter every level terminates on a cycle just
 * as surely as it does on genuine depth). Past this depth, both functions simply stop looking —
 * for `assertNoRegex` a truly pathological structure will already have hit a resource limit
 * (`maxCollectionSize`) building each of its many levels, and for `containsRegex`'s callers
 * (`encode_json`) the same shape hits `@ferrule/core`'s own JSON depth limit right after.
 */
const MAX_WALK_DEPTH = 1000;

/**
 * Recursively rejects a `RegexValue` anywhere inside `value` (including nested in arrays/objects —
 * this is the one place that nesting is actually walked; everywhere else a `RuntimeValue` array/
 * object is used as-is), returning a plain `Value` otherwise. Used at the two points a script
 * value becomes event data: assigning to an event path, and `emit()`.
 */
export function assertNoRegex(value: RuntimeValue, span: Span, depth = 0): Value {
  if (value instanceof RegexValue) {
    throw abortSignal(
      `a regex value (/${value.source}/${value.flags}) cannot be stored in event data`,
      span,
    );
  }
  if (depth >= MAX_WALK_DEPTH) return value as Value;
  if (Array.isArray(value)) {
    for (const el of value) assertNoRegex(el, span, depth + 1);
    return value as Value;
  }
  if (value instanceof Map) {
    for (const v of value.values()) assertNoRegex(v, span, depth + 1);
    return value as Value;
  }
  return value;
}

/** Like {@link assertNoRegex} but reports rather than aborts — for callers (e.g. `encode_json`)
 *  that want to return a `Failure` instead of unconditionally ending the event. */
export function containsRegex(value: RuntimeValue, depth = 0): boolean {
  if (isRegexValue(value)) return true;
  if (depth >= MAX_WALK_DEPTH) return false;
  if (Array.isArray(value)) return value.some((v) => containsRegex(v, depth + 1));
  if (value instanceof Map) return [...value.values()].some((v) => containsRegex(v, depth + 1));
  return false;
}
