import type { SourceFile } from '../syntax/source.js';
import type { Diagnostic, Label, Severity } from './diagnostic.js';

export interface RenderOptions {
  /** Colorize the output with ANSI escapes. Default `false`. */
  readonly color?: boolean;
  /** Lines of source shown around the primary span, on each side. Default `1`. */
  readonly context?: number;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/** Renders one diagnostic in a rustc-style snippet, with line numbers and carets. */
export function renderDiagnostic(
  diagnostic: Diagnostic,
  source: SourceFile,
  options: RenderOptions = {},
): string {
  const color = options.color ?? false;
  const context = options.context ?? 1;
  const paint = (code: string, text: string): string =>
    color ? `${code}${text}${ANSI.reset}` : text;
  const severityColor = severityAnsi(diagnostic.severity);

  const lines: string[] = [];
  const headline = `${paint(severityColor, `${diagnostic.severity}[${diagnostic.code}]`)}${paint(ANSI.bold, `: ${diagnostic.message}`)}`;
  lines.push(headline);

  const primaryStart = source.lineColumnAt(diagnostic.primary.span.start);
  lines.push(paint(ANSI.blue, `  --> ${source.name}:${primaryStart.line}:${primaryStart.column}`));

  lines.push(...renderSnippet(source, diagnostic.primary, severityColor, context, color, '^'));

  for (const secondary of diagnostic.secondary) {
    lines.push(...renderSnippet(source, secondary, ANSI.cyan, context, color, '-'));
  }

  for (const note of diagnostic.notes) {
    lines.push(`  ${paint(ANSI.dim, '=')} ${paint(ANSI.bold, 'note:')} ${note}`);
  }
  for (const fix of diagnostic.fixes) {
    lines.push(`  ${paint(ANSI.dim, '=')} ${paint(ANSI.bold, 'help:')} ${fix.description}`);
  }

  return lines.join('\n');
}

/** Renders every diagnostic, sorted by position, separated by a blank line. */
export function renderDiagnostics(
  diagnostics: readonly Diagnostic[],
  source: SourceFile,
  options: RenderOptions = {},
): string {
  const sorted = [...diagnostics].sort((a, b) => a.primary.span.start - b.primary.span.start);
  return sorted.map((d) => renderDiagnostic(d, source, options)).join('\n\n');
}

/** A one-line summary, e.g. `<file>:3:5: error[E301]: ...`, for compact tool output. */
export function summarizeDiagnostic(diagnostic: Diagnostic, source: SourceFile): string {
  const pos = source.lineColumnAt(diagnostic.primary.span.start);
  return `${source.name}:${pos.line}:${pos.column}: ${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`;
}

function severityAnsi(severity: Severity): string {
  switch (severity) {
    case 'error':
      return ANSI.red;
    case 'warning':
      return ANSI.yellow;
    case 'note':
      return ANSI.blue;
  }
}

function renderSnippet(
  source: SourceFile,
  label: Label,
  markColor: string,
  context: number,
  color: boolean,
  markChar: string,
): string[] {
  const paint = (code: string, text: string): string =>
    color ? `${code}${text}${ANSI.reset}` : text;
  const start = source.lineColumnAt(label.span.start);
  // Only the first line of a multi-line span is shown, to keep snippets compact and predictable.
  const endOnSameLine = source.lineColumnAt(Math.min(label.span.end, source.lineEnd(start.line)));
  const firstLine = Math.max(1, start.line - context);
  const lastLine = Math.min(source.lineCount, start.line + context);
  const gutterWidth = String(lastLine).length;

  const lines: string[] = [`  ${' '.repeat(gutterWidth)} ${paint(ANSI.dim, '|')}`];
  for (let line = firstLine; line <= lastLine; line++) {
    const text = source.lineText(line);
    const gutter = String(line).padStart(gutterWidth, ' ');
    lines.push(`  ${paint(ANSI.dim, gutter)} ${paint(ANSI.dim, '|')} ${text}`);
    if (line === start.line) {
      const caretStart = start.column - 1;
      const caretEnd = Math.max(caretStart + 1, endOnSameLine.column - 1);
      const caretLine =
        ' '.repeat(caretStart) + markChar.repeat(Math.max(1, caretEnd - caretStart));
      lines.push(
        `  ${' '.repeat(gutterWidth)} ${paint(ANSI.dim, '|')} ${paint(markColor, caretLine)}${label.message ? ` ${paint(markColor, label.message)}` : ''}`,
      );
    }
  }
  return lines;
}
