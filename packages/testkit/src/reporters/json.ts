import type { ReportSummary } from './types.js';

/** JSON summary reporter: a plain, stable, machine-readable shape. */

export interface JsonReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly {
    readonly suite: string;
    readonly name: string;
    readonly kind: string;
    readonly passed: boolean;
    readonly messages: readonly string[];
  }[];
}

export function toJsonReport(summary: ReportSummary): JsonReport {
  return {
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    cases: summary.cases.map((c) => ({
      suite: c.suite,
      name: c.name,
      kind: c.kind,
      passed: c.passed,
      messages: c.messages,
    })),
  };
}

export function renderJsonReport(summary: ReportSummary, pretty = true): string {
  return JSON.stringify(toJsonReport(summary), null, pretty ? 2 : undefined);
}
