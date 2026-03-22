import { formatValue } from '@ferrule/core';
import type { InlineScriptTestOutcome } from '../testfile/inlineScripts.js';
import type { TestFileResult } from '../testfile/runner.js';

/**
 * The reporter-agnostic shape every reporter (`human.ts`, `junit.ts`, `json.ts`) consumes: one
 * flat list of cases, whether they came from a pipeline test file's `cases` or a `script`
 * transform's inline `test { ... }` blocks.
 */

export type ReportCaseKind = 'pipeline' | 'inline_script';

export interface ReportCase {
  /** The test file path (`pipeline`) or the component ID (`inline_script`) this case belongs to. */
  readonly suite: string;
  readonly name: string;
  readonly kind: ReportCaseKind;
  readonly passed: boolean;
  /** Failure detail, one paragraph per failure, already formatted for display. Empty when passed. */
  readonly messages: readonly string[];
}

export interface ReportSummary {
  readonly cases: readonly ReportCase[];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

/** Converts pipeline test-file results into `ReportCase`s. */
export function pipelineReportCases(results: readonly TestFileResult[]): ReportCase[] {
  const cases: ReportCase[] = [];
  for (const file of results) {
    for (const c of file.cases) {
      cases.push({
        suite: file.file,
        name: c.name,
        kind: 'pipeline',
        passed: c.passed,
        messages: c.failures.map((f) => f.message),
      });
    }
  }
  return cases;
}

/** Converts inline `script` test-block outcomes into `ReportCase`s. */
export function inlineScriptReportCases(
  outcomes: readonly InlineScriptTestOutcome[],
): ReportCase[] {
  return outcomes.map((o) => {
    if (o.compileError !== undefined) {
      return {
        suite: o.componentId,
        name: '(compile)',
        kind: 'inline_script' as const,
        passed: false,
        messages: [o.compileError],
      };
    }
    const result = o.result!;
    const messages: string[] = [];
    if (!result.passed) {
      if (result.outcome.kind !== 'continue') {
        messages.push(
          `transform did not continue: ${result.outcome.kind}` +
            (result.outcome.kind === 'abort' ? ` (${result.outcome.reason})` : ''),
        );
      }
      for (const diff of result.diffs) {
        const actual = diff.actual === undefined ? 'missing' : formatValue(diff.actual);
        messages.push(`${diff.path}: expected ${formatValue(diff.expected)}, got ${actual}`);
      }
    }
    return {
      suite: o.componentId,
      name: result.name,
      kind: 'inline_script' as const,
      passed: result.passed,
      messages,
    };
  });
}

export function summarize(cases: readonly ReportCase[]): ReportSummary {
  const passed = cases.filter((c) => c.passed).length;
  return { cases, total: cases.length, passed, failed: cases.length - passed };
}
