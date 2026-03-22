import { FerruleError, type LogEvent } from '@ferrule/core';
import {
  compile,
  parseAndCheck,
  renderDiagnostics,
  SourceFile,
  type CompiledProgram,
} from '@ferrule/script';

/**
 * Compiles and evaluates a Ferrule Script boolean **expression** — the same wrapping approach
 * `@ferrule/operators`'s `filter`/`route` use (`if !(<condition>) { drop }`; see either's doc
 * comment for the full rationale), reimplemented independently here since `@ferrule/testkit`
 * does not depend on `@ferrule/operators`. Used by the pipeline test runner's `conditions`
 * expectations and directly available for a hand-written test.
 */

export const E_CONDITION_COMPILE = 'E_TESTKIT_CONDITION_COMPILE';

/** Compiles `expression` (unwrapped: no `?? fallback`, since a failed condition is a test failure, not a silent default). Throws `FerruleError` with a rendered code frame on a compile error. */
export function compileCondition(expression: string, name = '<condition>'): CompiledProgram {
  const source = `if !(${expression}) { drop }`;
  const file = new SourceFile(name, source);
  const result = parseAndCheck(file);
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    throw new FerruleError(
      E_CONDITION_COMPILE,
      `condition failed to compile:\n\n${renderDiagnostics(errors, file, { color: false })}`,
    );
  }
  return compile(result);
}

export type ConditionResult =
  | { readonly ok: true; readonly matched: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Runs `program` against a **clone** of `event` (so evaluating a condition never mutates the
 * event a test captured for other assertions) and reports whether it matched. `ok: false` means
 * the condition itself failed at runtime (an unhandled `Failure`, an explicit `abort()`, or an
 * `any`-typed mismatch) — distinct from `matched: false`, which means it evaluated cleanly to
 * `false`.
 */
export function evaluateCondition(program: CompiledProgram, event: LogEvent): ConditionResult {
  const outcome = program.run(event.clone());
  if (outcome.kind === 'continue') return { ok: true, matched: true };
  if (outcome.kind === 'drop') return { ok: true, matched: false };
  return { ok: false, reason: outcome.reason };
}
