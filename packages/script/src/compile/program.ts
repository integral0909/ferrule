import type { LogEvent, MetricEvent } from '@ferrule/core';
import type { CheckResult, ResolvedCall } from '../check/typedProgram.js';
import { createDefaultImplementations } from '../stdlib/index.js';
import type { ImplementationRegistry } from '../registry/implementation.js';
import {
  createRunCtx,
  RateLimiter,
  type Exec,
  type Frame,
  type RunOptions,
  type RuntimeValue,
  type ScriptEvent,
  type ScriptTarget,
} from '../runtime/context.js';
import { ScriptBugError } from '../runtime/failure.js';
import type { Outcome } from '../runtime/outcome.js';
import { ScriptSignal } from '../runtime/signal.js';
import type { CallExpr, Program, TestDecl } from '../syntax/ast.js';
import type { Span } from '../syntax/source.js';
import { Compiler } from './compiler.js';
import { optimizeProgram } from './optimizer.js';
import { CompileScope } from './scope.js';

export interface CompileOptions {
  /** Defaults to `createDefaultImplementations()` from `stdlib/index.js`. */
  readonly implementations?: ImplementationRegistry;
  /** Runs the optimizer (`compile/optimizer.ts`) before compiling. Default `true`. */
  readonly optimize?: boolean;
  /** How many `log()` calls per second are forwarded to `RunOptions.onLog`. Default 100. */
  readonly logsPerSecond?: number;
  /**
   * Which event kind the program runs against. Default `'log'`. Must match the `target` the
   * program was *checked* with (`CheckOptions.target`), since the checker resolves `.path` types
   * — and rejects unknown metric fields — against the matching shape.
   */
  readonly target?: ScriptTarget;
}

/**
 * A compiled Ferrule Script program: a tree of closures ready to run against events of one kind.
 *
 * The kind is a *type* parameter, not a runtime input: `CompiledProgram` with no argument is a
 * log program, exactly as before, and `compile(result, { target: 'metric' })` returns a
 * `CompiledProgram<MetricEvent>` whose `run` takes a `MetricEvent`. Mixing them is a TypeScript
 * error at the call site rather than a runtime check, because a program's `.path` accessors are
 * specialised for one shape when it is compiled (see the README's "Execution model"). `SpanEvent`
 * is still unsupported.
 */
export interface CompiledProgram<E extends ScriptEvent = LogEvent> {
  /** Which event kind this program was compiled against. */
  readonly target: ScriptTarget;
  /** Size of the `Frame` array `run` allocates per call; exposed for diagnostics/benchmarking. */
  readonly slotCount: number;
  /** The program's `test { ... }` blocks, in source order, for `runInlineTests` (`compile/testRunner.ts`). */
  readonly tests: readonly TestDecl[];
  /** The checked program this was compiled from, for `runInlineTests`. */
  readonly checkResult: CheckResult;
  readonly implementations: ImplementationRegistry;
  run(event: E, options?: RunOptions): Outcome<E>;
}

/** A compiled program of either kind, for code that handles both (e.g. `runInlineTests`). */
export type AnyCompiledProgram = CompiledProgram<LogEvent> | CompiledProgram<MetricEvent>;

/** Compiles a checked program. Throws if `checkResult` has any error-severity diagnostic. */
export function compile(
  checkResult: CheckResult,
  options?: CompileOptions & { readonly target?: 'log' },
): CompiledProgram<LogEvent>;
export function compile(
  checkResult: CheckResult,
  options: CompileOptions & { readonly target: 'metric' },
): CompiledProgram<MetricEvent>;
export function compile(checkResult: CheckResult, options?: CompileOptions): AnyCompiledProgram;
export function compile(
  checkResult: CheckResult,
  options: CompileOptions = {},
): AnyCompiledProgram {
  if (checkResult.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error(
      'cannot compile a program with unresolved errors; fix checkResult.diagnostics first',
    );
  }
  const implementations = options.implementations ?? createDefaultImplementations();
  const optimize = options.optimize ?? true;
  let program: Program = checkResult.program;
  let calls: ReadonlyMap<CallExpr, ResolvedCall> | undefined;
  if (optimize) {
    const optimized = optimizeProgram(checkResult.program, checkResult, implementations);
    program = optimized.program;
    calls = optimized.calls;
  }

  const target: ScriptTarget = options.target ?? 'log';
  const compiler = new Compiler(checkResult, implementations, calls, target);
  const rootScope = new CompileScope(compiler.alloc);
  const transformStatements = program.statements.filter((s) => s.kind !== 'test');
  const tests = program.statements.filter((s): s is TestDecl => s.kind === 'test');
  const execs: Exec[] = compiler.compileStatements(transformStatements, rootScope);

  const slotCount = compiler.alloc.slotCount;
  const logLimiter = new RateLimiter(options.logsPerSecond ?? 100);
  const rootSpan: Span = program.span;

  // The `run` below is written once for both kinds; `target` (fixed above) decides which one it
  // actually receives, which the `AnyCompiledProgram` union cannot express in a single signature.
  return {
    target,
    slotCount,
    tests,
    checkResult,
    implementations,
    run(event: ScriptEvent, runOptions?: RunOptions): Outcome<ScriptEvent> {
      const ctx = createRunCtx(event, runOptions, logLimiter, rootSpan);
      const frame: Frame = new Array<RuntimeValue>(slotCount).fill(null);
      try {
        for (const exec of execs) exec(frame, ctx);
      } catch (error) {
        return outcomeForError(error, ctx.currentSpan);
      }
      return { kind: 'continue', events: [event, ...ctx.emitted] };
    },
  } as AnyCompiledProgram;
}

/**
 * Generic in `E` because it only ever produces the `drop`/`abort` variants, which carry no
 * events and so fit any program's `Outcome`.
 */
export function outcomeForError<E extends ScriptEvent = LogEvent>(
  error: unknown,
  fallbackSpan: Span,
): Outcome<E> {
  if (error instanceof ScriptSignal) {
    if (error.signalKind === 'drop') return { kind: 'drop' };
    if (error.signalKind === 'limit') {
      return {
        kind: 'abort',
        reason: `limit exceeded: ${error.reason}`,
        span: error.span,
        cause: 'limit',
      };
    }
    return { kind: 'abort', reason: error.reason, span: error.span, cause: 'abort' };
  }
  if (error instanceof ScriptBugError) {
    return { kind: 'abort', reason: error.message, span: error.span, cause: 'internal' };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'abort',
    reason: `internal error: ${message}`,
    span: fallbackSpan,
    cause: 'internal',
  };
}
