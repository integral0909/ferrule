import type { LogEvent } from '@ferrule/core';
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
}

/**
 * A compiled Ferrule Script program: a tree of closures ready to run against log events.
 *
 * `run` restricts its input to {@link LogEvent} at the type level — this milestone's compiler
 * does not support metric or span events (see the README's "Execution model" section for the
 * reasoning); a caller with a `MetricEvent`/`SpanEvent` must convert it or route around the
 * program, which is a compile-time (type-checking) decision rather than a runtime one.
 */
export interface CompiledProgram {
  /** Size of the `Frame` array `run` allocates per call; exposed for diagnostics/benchmarking. */
  readonly slotCount: number;
  /** The program's `test { ... }` blocks, in source order, for `runInlineTests` (`compile/testRunner.ts`). */
  readonly tests: readonly TestDecl[];
  /** The checked program this was compiled from, for `runInlineTests`. */
  readonly checkResult: CheckResult;
  readonly implementations: ImplementationRegistry;
  run(event: LogEvent, options?: RunOptions): Outcome;
}

/** Compiles a checked program. Throws if `checkResult` has any error-severity diagnostic. */
export function compile(checkResult: CheckResult, options: CompileOptions = {}): CompiledProgram {
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

  const compiler = new Compiler(checkResult, implementations, calls);
  const rootScope = new CompileScope(compiler.alloc);
  const transformStatements = program.statements.filter((s) => s.kind !== 'test');
  const tests = program.statements.filter((s): s is TestDecl => s.kind === 'test');
  const execs: Exec[] = compiler.compileStatements(transformStatements, rootScope);

  const slotCount = compiler.alloc.slotCount;
  const logLimiter = new RateLimiter(options.logsPerSecond ?? 100);
  const rootSpan: Span = program.span;

  return {
    slotCount,
    tests,
    checkResult,
    implementations,
    run(event: LogEvent, runOptions?: RunOptions): Outcome {
      const ctx = createRunCtx(event, runOptions, logLimiter, rootSpan);
      const frame: Frame = new Array<RuntimeValue>(slotCount).fill(null);
      try {
        for (const exec of execs) exec(frame, ctx);
      } catch (error) {
        return outcomeForError(error, ctx.currentSpan);
      }
      return { kind: 'continue', events: [event, ...ctx.emitted] };
    },
  };
}

export function outcomeForError(error: unknown, fallbackSpan: Span): Outcome {
  if (error instanceof ScriptSignal) {
    if (error.signalKind === 'drop') return { kind: 'drop' };
    if (error.signalKind === 'limit') {
      return { kind: 'abort', reason: `limit exceeded: ${error.reason}`, span: error.span };
    }
    return { kind: 'abort', reason: error.reason, span: error.span };
  }
  if (error instanceof ScriptBugError) {
    return { kind: 'abort', reason: error.message, span: error.span };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'abort', reason: `internal error: ${message}`, span: fallbackSpan };
}
