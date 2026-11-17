import { FerruleError, type LogEvent, type MetricEvent } from '@ferrule/core';
import {
  compile,
  type AnyCompiledProgram,
  type ScriptTarget,
  parseAndCheck,
  renderDiagnostic,
  renderDiagnostics,
  SourceFile,
  type CompiledProgram,
  type Diagnostic,
  type Fix,
  type Label,
  type Span,
  type TextEdit,
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
  /**
   * Which event kind the program runs against (`@ferrule/script`'s `ScriptTarget`). Default
   * `'log'`. With `'metric'`, paths resolve against the fixed metric shape instead, and
   * {@link inputSchema} — which describes a *log* event's free-form fields — must not be given.
   */
  readonly target?: ScriptTarget;
}

/** Shared by {@link compileScriptSource} and {@link compileConditionSource}. */
function checkOptionsFor(options: CompileScriptOptions): {
  inputSchema?: Type;
  target?: ScriptTarget;
} {
  const checkOptions: { inputSchema?: Type; target?: ScriptTarget } = {};
  if (options.inputSchema !== undefined) checkOptions.inputSchema = options.inputSchema;
  if (options.target !== undefined) checkOptions.target = options.target;
  return checkOptions;
}

function compileOptionsFor(options: CompileScriptOptions): {
  optimize?: boolean;
  target?: ScriptTarget;
} {
  const compileOptions: { optimize?: boolean; target?: ScriptTarget } = {};
  if (options.optimize !== undefined) compileOptions.optimize = options.optimize;
  if (options.target !== undefined) compileOptions.target = options.target;
  return compileOptions;
}

/**
 * Parses, checks, and compiles `source`. `fileName` is used only for diagnostics. `script` uses
 * this directly, since its `source` option already is exactly what the user wrote; `filter` and
 * `route` compile a boolean *condition* through {@link compileConditionSource} instead, which
 * renders diagnostics against the condition text itself rather than the synthetic wrapper program
 * it actually compiles.
 */
export function compileScriptSource(
  source: string,
  fileName: string,
  options?: CompileScriptOptions & { readonly target?: 'log' },
): CompiledProgram<LogEvent>;
export function compileScriptSource(
  source: string,
  fileName: string,
  options: CompileScriptOptions & { readonly target: 'metric' },
): CompiledProgram<MetricEvent>;
export function compileScriptSource(
  source: string,
  fileName: string,
  options?: CompileScriptOptions,
): AnyCompiledProgram;
export function compileScriptSource(
  source: string,
  fileName: string,
  options: CompileScriptOptions = {},
): AnyCompiledProgram {
  if (options.target === 'metric' && options.inputSchema !== undefined) {
    throw new FerruleError(
      E_SCRIPT_COMPILE,
      "input_schema describes a log event's fields and cannot be combined with a metric script: a metric's shape is fixed",
    );
  }
  const file = new SourceFile(fileName, source);
  const result = parseAndCheck(file, checkOptionsFor(options));
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    const rendered = renderDiagnostics(errors, file, { color: false });
    throw new FerruleError(E_SCRIPT_COMPILE, `script failed to compile:\n\n${rendered}`);
  }
  return compile(result, compileOptionsFor(options));
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
 *
 * Exported for callers that need the exact wrapper text (e.g. to reproduce
 * {@link compileConditionSource}'s span mapping); compiling a condition should normally go
 * through {@link compileConditionSource} instead, which renders diagnostics against the
 * condition text itself rather than this wrapper.
 */
export function wrapBooleanCondition(condition: string, fallbackWhenFailed: boolean): string {
  return `if !((${condition}) ?? ${fallbackWhenFailed ? 'true' : 'false'}) { drop }`;
}

/** The fixed text {@link wrapBooleanCondition} puts before the condition, `if !((`. */
const WRAPPER_PREFIX_LENGTH = 'if !(('.length;

/**
 * Maps a span in the wrapper source back to an offset into the condition alone, if it starts
 * inside (or right at the end of) the condition's own text. `end` is clamped to the condition's
 * length rather than rejected when it overshoots: a "the expression ended too soon" error is
 * reported *at* the wrapper's own closing `)` (the one grouping the condition, immediately after
 * it) — one character past the condition's last one — and that clamps down to a zero-width span
 * right after the condition's last character, which is exactly where such an error belongs.
 */
function remapSpan(span: Span, conditionLength: number): Span | undefined {
  const start = span.start - WRAPPER_PREFIX_LENGTH;
  if (start < 0 || start > conditionLength) return undefined;
  const end = Math.min(span.end - WRAPPER_PREFIX_LENGTH, conditionLength);
  if (end < start) return undefined;
  return { start, end };
}

function remapLabel(label: Label, conditionLength: number): Label | undefined {
  const span = remapSpan(label.span, conditionLength);
  return span === undefined ? undefined : { span, message: label.message };
}

function remapFix(fix: Fix, conditionLength: number): Fix | undefined {
  const edits: TextEdit[] = [];
  for (const edit of fix.edits) {
    const span = remapSpan(edit.span, conditionLength);
    if (span === undefined) return undefined;
    edits.push({ span, newText: edit.newText });
  }
  return { description: fix.description, edits };
}

/**
 * Remaps `diagnostic`'s spans — primary label, secondary labels, and any fix's edits — from an
 * offset into the {@link wrapBooleanCondition} wrapper source to an offset into the condition
 * text alone, so it can be rendered against a `SourceFile` built from that text directly. Returns
 * `undefined`, rather than a partially-mapped diagnostic, if any span falls outside the
 * condition's own text: the wrapper's fixed scaffolding around `condition` (`if !((`, `) ?? true)
 * { drop }` / `) ?? false) { drop }`) is always valid, already-checked script the checker never
 * flags on its own, so this should never actually happen — but a caller that hits it should fall
 * back to rendering against the wrapper rather than risk a diagnostic pointing at the wrong text.
 */
function remapDiagnosticToCondition(
  diagnostic: Diagnostic,
  conditionLength: number,
): Diagnostic | undefined {
  const primary = remapLabel(diagnostic.primary, conditionLength);
  if (primary === undefined) return undefined;
  const secondary: Label[] = [];
  for (const label of diagnostic.secondary) {
    const remapped = remapLabel(label, conditionLength);
    if (remapped === undefined) return undefined;
    secondary.push(remapped);
  }
  const fixes: Fix[] = [];
  for (const fix of diagnostic.fixes) {
    const remapped = remapFix(fix, conditionLength);
    if (remapped === undefined) return undefined;
    fixes.push(remapped);
  }
  return { ...diagnostic, primary, secondary, fixes };
}

/**
 * Renders `errors` the same way {@link renderDiagnostics} does (sorted by position, one blank
 * line between each) but per-diagnostic against whichever source fits it best: `conditionFile`
 * (the user's own condition text) for one {@link remapDiagnosticToCondition} can map onto it,
 * `wrapperFile` otherwise — so a diagnostic that happens to fall in the wrapper's own scaffolding
 * (which should not normally happen, but isn't a `@ferrule/script` bug if it does) still renders
 * a valid code frame instead of being dropped.
 */
function renderConditionDiagnostics(
  errors: readonly Diagnostic[],
  wrapperFile: SourceFile,
  conditionFile: SourceFile,
  conditionLength: number,
): string {
  const sorted = [...errors].sort((a, b) => a.primary.span.start - b.primary.span.start);
  return sorted
    .map((d) => {
      const mapped = remapDiagnosticToCondition(d, conditionLength);
      return mapped === undefined
        ? renderDiagnostic(d, wrapperFile, { color: false })
        : renderDiagnostic(mapped, conditionFile, { color: false });
    })
    .join('\n\n');
}

/**
 * Compiles a filter/route boolean `condition` (see {@link wrapBooleanCondition}), like
 * {@link compileScriptSource}, but renders a compile error's code frame against the user's own
 * `condition` text instead of the synthetic wrapper it actually compiles: every diagnostic's
 * spans are mapped from an offset into the wrapper back to an offset into `condition` alone (see
 * {@link remapDiagnosticToCondition}), and rendered with a `SourceFile` whose text is exactly
 * `condition` — so the code frame a person sees shows their own expression, with the caret under
 * the right token in it, not the `if !((...) ?? ...) { drop }` scaffolding around it.
 */
export function compileConditionSource(
  condition: string,
  fallbackWhenFailed: boolean,
  fileName: string,
  // Conditions are log-only: `filter` and `route` evaluate them against log events and pass
  // other kinds through, matching `@ferrule/testkit`'s documented condition behaviour.
  options: Omit<CompileScriptOptions, 'target'> = {},
): CompiledProgram<LogEvent> {
  const wrapperFile = new SourceFile(fileName, wrapBooleanCondition(condition, fallbackWhenFailed));
  const result = parseAndCheck(wrapperFile, checkOptionsFor(options));
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    const conditionFile = new SourceFile(fileName, condition);
    const rendered = renderConditionDiagnostics(
      errors,
      wrapperFile,
      conditionFile,
      condition.length,
    );
    throw new FerruleError(E_SCRIPT_COMPILE, `script failed to compile:\n\n${rendered}`);
  }
  return compile(result, { ...compileOptionsFor(options), target: 'log' });
}
