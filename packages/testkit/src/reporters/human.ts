import type { ReportCase, ReportSummary } from './types.js';

/** Human-readable reporter: grouped by suite, colors optional. */

export interface HumanReportOptions {
  readonly color?: boolean;
}

const ANSI: Readonly<Record<string, readonly [string, string]>> = {
  bold: ['\x1b[1m', '\x1b[22m'],
  red: ['\x1b[31m', '\x1b[39m'],
  green: ['\x1b[32m', '\x1b[39m'],
  dim: ['\x1b[2m', '\x1b[22m'],
};

function paint(color: boolean, style: keyof typeof ANSI, text: string): string {
  if (!color) return text;
  const [open, close] = ANSI[style]!;
  return `${open}${text}${close}`;
}

export function renderHumanReport(
  summary: ReportSummary,
  options: HumanReportOptions = {},
): string {
  const color = options.color ?? false;
  const lines: string[] = [];

  const bySuite = new Map<string, ReportCase[]>();
  for (const c of summary.cases) {
    const list = bySuite.get(c.suite) ?? [];
    list.push(c);
    bySuite.set(c.suite, list);
  }

  for (const [suite, cases] of bySuite) {
    lines.push(paint(color, 'bold', suite));
    for (const c of cases) {
      const mark = c.passed ? paint(color, 'green', '✓') : paint(color, 'red', '✗');
      lines.push(`  ${mark} ${c.name}`);
      if (!c.passed) {
        for (const message of c.messages) {
          for (const line of message.split('\n')) lines.push(`      ${paint(color, 'dim', line)}`);
        }
      }
    }
    lines.push('');
  }

  const summaryLine =
    summary.failed === 0
      ? paint(color, 'green', `${summary.passed}/${summary.total} passed`)
      : paint(color, 'red', `${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
  lines.push(summaryLine);

  return lines.join('\n');
}
