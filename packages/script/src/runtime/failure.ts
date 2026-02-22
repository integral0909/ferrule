import type { Span } from '../syntax/source.js';

/**
 * The result of a fallible operation that failed.
 *
 * Ferrule Script's fallibility (design.md §5) is common enough — every `to_int`, `parse_json`,
 * array index, or `/` by a variable divisor can produce one — that it sits on what the compiler
 * treats as the hot path. A plain sentinel *value* returned alongside (never thrown) is
 * measurably cheaper than a JavaScript exception for this: V8 does not need to build a stack
 * trace or unwind frames, `??`/`!`/error-capture compile to a single `instanceof` check, and the
 * success path allocates nothing extra. See the package README ("Runtime: fallibility") for the
 * rationale and the alternative (throwing) that this deliberately avoids.
 *
 * By contrast, `drop`, `abort`, and resource-limit violations are rare and always terminate the
 * whole program run, so they use {@link ScriptSignal}, a single exception type thrown once and
 * caught only at the top of {@link CompiledProgram.run} — see `runtime/signal.ts`.
 */
export class Failure {
  constructor(readonly message: string) {}
}

export function isFailure(value: unknown): value is Failure {
  return value instanceof Failure;
}

/** Compile-time helper: builds a `Failure` with a message computed once, no per-call allocation. */
export function failure(message: string): Failure {
  return new Failure(message);
}

/**
 * Asserts a fallible result is not a {@link Failure}. Used only at compiler-verified "definitely
 * handled" boundaries (see `compile/expr.ts`'s `compileHandled`): if this ever throws, it is a
 * bug in the compiler or checker, not in the compiled program, and it is reported as such (see
 * `runtime/signal.ts`'s `ScriptBugError`).
 */
export function assertValue<T>(result: T | Failure, span: Span): T {
  if (result instanceof Failure) {
    throw new ScriptBugError(
      `internal error: an expression the checker marked as unfailing produced a failure (${result.message})`,
      span,
    );
  }
  return result;
}

/** Thrown for a bug in the compiler or checker, never for a fault in the compiled program itself. */
export class ScriptBugError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = 'ScriptBugError';
  }
}
