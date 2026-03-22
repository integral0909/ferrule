import type { ReportCase, ReportSummary } from './types.js';

/** JUnit XML reporter, for CI integrations that consume that format. */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeAttr(text: string): string {
  // eslint-disable-next-line no-control-regex
  return escapeXml(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function renderCase(c: ReportCase): string {
  const name = escapeAttr(c.name);
  const classname = escapeAttr(c.suite);
  if (c.passed) {
    return `    <testcase classname="${classname}" name="${name}"/>`;
  }
  const message = escapeAttr(c.messages[0] ?? 'failed');
  const body = escapeXml(c.messages.join('\n\n'));
  return [
    `    <testcase classname="${classname}" name="${name}">`,
    `      <failure message="${message}">${body}</failure>`,
    `    </testcase>`,
  ].join('\n');
}

export function renderJunitReport(summary: ReportSummary, suiteName = 'ferrule test'): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeAttr(suiteName)}" tests="${summary.total}" failures="${summary.failed}">`,
    `  <testsuite name="${escapeAttr(suiteName)}" tests="${summary.total}" failures="${summary.failed}">`,
  ];
  for (const c of summary.cases) lines.push(renderCase(c));
  lines.push('  </testsuite>', '</testsuites>');
  return lines.join('\n');
}
