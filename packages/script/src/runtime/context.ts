import type { LogEvent, Value } from '@ferrule/core';
import { Timestamp } from '@ferrule/core';
import type { Span } from '../syntax/source.js';
import type { Failure } from './failure.js';
import { type ResourceLimits, resolveLimits } from './limits.js';
import type { RegexValue } from './regex.js';

/**
 * Everything a compiled expression can evaluate to: a `Value` shape (event data), but with
 * `RegexValue` (`runtime/regex.ts`) added as a possible leaf and — unlike `Value` — allowed
 * *inside* an array or object, not just as a top-level scalar. A script-local array/object may
 * freely hold a regex (e.g. `redact`'s `patterns: array<string|regex>` argument, or `let
 * patterns = [r/.../, "literal"]`); only the two places a value actually becomes *event data* —
 * assigning to an event path (`.field = ...`) and `emit()` — reject one, recursively
 * (`runtime/regex.ts`'s `assertNoRegex`), since `@ferrule/core`'s `Value` has no regex variant at
 * all. This is a strict superset of `Value`: every `Value` (including nested `Value[]`/`ValueMap`)
 * is already a valid `RuntimeValue`.
 */
export type RuntimeValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | Uint8Array
  | Timestamp
  | RegexValue
  | RuntimeValue[]
  | Map<string, RuntimeValue>;

/**
 * A compiled expression closure's local variable storage: one flat array of slots, indexed by the
 * numbers `compile/scope.ts`'s `SlotAllocator` assigns at compile time. One `Frame` is allocated
 * per `run()` call (see `compile/program.ts`) and never resized, so there is exactly one array
 * allocation for the whole event, regardless of how many `let`s or closures the program has.
 */
export type Frame = RuntimeValue[];

/** A compiled expression that the checker has proven cannot fail. */
export type Eval = (frame: Frame, ctx: RunCtx) => RuntimeValue;

/** A compiled expression that may fail; see `runtime/failure.ts`. */
export type EvalFallible = (frame: Frame, ctx: RunCtx) => RuntimeValue | Failure;

/** A compiled statement. Returns nothing; side effects go through `frame`/`ctx`. */
export type Exec = (frame: Frame, ctx: RunCtx) => void;

/** A compiled closure argument (`|x, y| ...`), invoked with already-evaluated argument values. */
export type CompiledClosure = (
  args: readonly RuntimeValue[],
  ctx: RunCtx,
) => RuntimeValue | Failure;

/** A rate limiter shared across every run of one compiled program, for the `log()` builtin. */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly maxPerSecond: number,
    private readonly nowMillis: () => number = Date.now,
  ) {}

  /** Returns true if a call is allowed right now, and records it if so. */
  allow(): boolean {
    const now = this.nowMillis();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.maxPerSecond) return false;
    this.count++;
    return true;
  }
}

export interface LogSink {
  (entry: { readonly level: string; readonly message: Value; readonly span: Span }): void;
}

/** Runtime options for a single {@link CompiledProgram.run} call. */
export interface RunOptions {
  readonly limits?: Partial<ResourceLimits>;
  /** Clock used by `now()`, timestamp defaults, and rate limiting. Defaults to the system clock. */
  readonly clock?: () => Timestamp;
  /** Receives `log()` calls that pass the program's rate limit. Defaults to doing nothing. */
  readonly onLog?: LogSink;
}

/**
 * Per-run state threaded through every compiled closure. Not exported as part of the public
 * surface beyond what standard library implementations need (see `registry/implementation.ts`).
 */
export interface RunCtx {
  readonly event: LogEvent;
  readonly limits: ResourceLimits;
  readonly clock: () => Timestamp;
  readonly onLog: LogSink;
  readonly logLimiter: RateLimiter;
  /** Events `emit()` has produced so far, in order. Only log events; see the README's "Execution
   *  model" section for why metric/span emission is out of scope for this milestone. */
  readonly emitted: LogEvent[];
  /** The span of the statement currently executing, for wrapping an unexpected exception. */
  currentSpan: Span;
}

export function createRunCtx(
  event: LogEvent,
  options: RunOptions | undefined,
  logLimiter: RateLimiter,
  initialSpan: Span,
): RunCtx {
  return {
    event,
    limits: resolveLimits(options?.limits),
    clock: options?.clock ?? (() => Timestamp.now()),
    onLog: options?.onLog ?? (() => {}),
    logLimiter,
    emitted: [],
    currentSpan: initialSpan,
  };
}
