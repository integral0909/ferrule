import type { Span } from '../syntax/source.js';

/**
 * The kinds of terminal control flow a running program can raise. Each one ends the run
 * immediately and is turned into an {@link Outcome} by `compile/program.ts`'s `run`.
 *
 * - `drop` — `drop` was evaluated.
 * - `abort` — `abort`/`abort "reason"` was evaluated, `!` was applied to a failed expression, or
 *   an `any`-typed operator saw operands of a kind it cannot work with at runtime (see the
 *   README's "Runtime: `any` and operators" for why this is an abort and not a `Failure`).
 * - `limit` — a resource limit (`runtime/limits.ts`) was exceeded.
 */
export type SignalKind = 'drop' | 'abort' | 'limit';

/**
 * Thrown once to unwind out of arbitrarily nested compiled closures back to the top of `run`.
 * Unlike {@link Failure}, this is not on the hot path: by construction every program run throws
 * at most one of these, and only for a run that is ending anyway, so the cost of an exception is
 * irrelevant. Kept as a single class (rather than one per kind) so `run`'s catch site is simple.
 */
export class ScriptSignal extends Error {
  constructor(
    readonly signalKind: SignalKind,
    readonly reason: string,
    readonly span: Span,
  ) {
    super(reason);
    this.name = 'ScriptSignal';
  }
}

export function dropSignal(span: Span): ScriptSignal {
  return new ScriptSignal('drop', 'drop', span);
}

export function abortSignal(reason: string, span: Span): ScriptSignal {
  return new ScriptSignal('abort', reason, span);
}

export function limitSignal(reason: string, span: Span): ScriptSignal {
  return new ScriptSignal('limit', reason, span);
}
