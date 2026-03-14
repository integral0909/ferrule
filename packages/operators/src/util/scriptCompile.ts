import { FerruleError } from '@ferrule/core';
import {
  compile,
  parseAndCheck,
  renderDiagnostics,
  SourceFile,
  type CompiledProgram,
  type Type,
} from '@ferrule/script';

/**
 * Shared compile-at-build-time plumbing for `script`, `filter`, and `route`: parse and check a
 * Ferrule Script source, and if it has any error-severity diagnostic, throw a `FerruleError`
 * whose message is the rendered code frame(s) — per `packages/runtime/README.md`'s "build time
 * vs run time", `TransformDefinition.build` runs during validation, so this surfaces compile
 * errors before the pipeline ever starts, with the same diagnostics a person would see from
 * `ferrule validate`.
 */

/** Code on the `FerruleError` thrown for a Ferrule Script program that fails to compile. */
export const E_SCRIPT_COMPILE = 'E_SCRIPT_COMPILE';

export interface CompileScriptOptions {
  /** Types `.field` paths against a declared event shape. Default: every path is `any`. */
  readonly inputSchema?: Type;
  /** Runs the optimizer. Default `true` (matches `@ferrule/script`'s own default). */
  readonly optimize?: boolean;
}

/**
 * Parses, checks, and compiles `source`. `fileName` is used only for diagnostics (and, for a
 * synthetic wrapper source built by `filter`/`route`, means rendered positions are relative to
 * the wrapper, not the user's original condition text — documented in those transforms' options).
 */
export function compileScriptSource(
  source: string,
  fileName: string,
  options: CompileScriptOptions = {},
): CompiledProgram {
  const file = new SourceFile(fileName, source);
  const result = parseAndCheck(
    file,
    options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema },
  );
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    const rendered = renderDiagnostics(errors, file, { color: false });
    throw new FerruleError(E_SCRIPT_COMPILE, `script failed to compile:\n\n${rendered}`);
  }
  const compileOptions: { optimize?: boolean } = {};
  if (options.optimize !== undefined) compileOptions.optimize = options.optimize;
  return compile(result, compileOptions);
}

/**
 * Wraps a Ferrule Script boolean *expression* (not a full program) so it can be compiled and run
 * as a filter/route decision, using the language's own `drop` control flow instead of writing a
 * scratch field into the event: `if !((<condition>) ?? <fallback>) { drop }`. `run()`'s outcome
 * then doubles as the decision — `continue` means the condition was true, `drop` means false.
 * `??` only matters for a *fallible* condition (a `Failure`, e.g. an unhandled `to_int(...)`); it
 * is not applied to a non-fallible condition at the type-checker level, only spliced into the
 * source text, and the checker merely warns (never errors) when `??`'s left side cannot fail — see
 * `checkCoalesce` in `@ferrule/script`'s checker. An `abort` (uncatchable by `??`) is not decided
 * here; callers inspect `Outcome.kind === 'abort'` themselves and apply their own `on_error`
 * policy. Used by `filter` and `route`; see either's module doc for the full rationale.
 */
export function wrapBooleanCondition(condition: string, fallbackWhenFailed: boolean): string {
  return `if !((${condition}) ?? ${fallbackWhenFailed ? 'true' : 'false'}) { drop }`;
}
