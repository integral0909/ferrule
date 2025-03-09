import { FerruleError } from '@ferrule/core';
import { formatIssuePath, type Issue } from '@ferrule/schema';
import type { Range, SourceLocation } from './position.js';
import { LineIndex } from './position.js';
import type { SecretRegistry } from './secrets.js';

/** One problem found while loading a config, ready to show to a person. */
export interface ConfigDiagnostic {
  readonly file: string;
  readonly range: Range | undefined;
  readonly message: string;
  readonly hint?: string;
  readonly code: string;
}

/** Raised by the loader when one or more {@link ConfigDiagnostic}s make the config unusable. */
export class ConfigError extends FerruleError {
  readonly diagnostics: readonly ConfigDiagnostic[];
  /** The text of every file involved in the load, so callers can render code frames without re-reading disk. */
  readonly sources: ReadonlyMap<string, string>;

  constructor(
    diagnostics: readonly ConfigDiagnostic[],
    sources: ReadonlyMap<string, string> = new Map(),
  ) {
    super(
      'E_CONFIG',
      `invalid configuration: ${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'} found`,
    );
    this.name = 'ConfigError';
    this.diagnostics = diagnostics;
    this.sources = sources;
  }
}

/** What {@link PositionMap} and its multi-file counterpart both provide, used to place diagnostics. */
export interface PositionLookup {
  resolve(path: readonly (string | number)[]): SourceLocation | undefined;
  resolveKey(path: readonly (string | number)[]): SourceLocation | undefined;
}

const KEY_ISSUE_CODES: ReadonlySet<string> = new Set(['required', 'unknown_key']);

/** Turns a schema {@link Issue} into a {@link ConfigDiagnostic}, placed via `lookup`. */
export function issueToDiagnostic(issue: Issue, lookup: PositionLookup): ConfigDiagnostic {
  const location = KEY_ISSUE_CODES.has(issue.code)
    ? lookup.resolveKey(issue.path)
    : lookup.resolve(issue.path);
  const diagnostic: ConfigDiagnostic = {
    file: location?.file ?? '(unknown)',
    range: location?.range,
    message: `${formatIssuePath(issue.path)}: ${issue.message}`,
    code: issue.code,
  };
  return issue.hint === undefined ? diagnostic : { ...diagnostic, hint: issue.hint };
}

export interface RenderDiagnosticsOptions {
  /** Colour the output with ANSI escapes. Default false. */
  color?: boolean;
  /** Secrets to scrub from rendered messages and source lines before they are ever printed. */
  secrets?: SecretRegistry;
}

/**
 * Renders diagnostics as code frames: `file:line:col: error[code]: message`, followed by the
 * offending source lines with a caret underline. Secrets are redacted from both the message and
 * the quoted source before anything is written to the returned string.
 */
export function renderDiagnostics(
  diagnostics: readonly ConfigDiagnostic[],
  sources: ReadonlyMap<string, string>,
  options: RenderDiagnosticsOptions = {},
): string {
  return diagnostics.map((d) => renderOne(d, sources, options)).join('\n\n');
}

function renderOne(
  d: ConfigDiagnostic,
  sources: ReadonlyMap<string, string>,
  options: RenderDiagnosticsOptions,
): string {
  const color = options.color ?? false;
  const redact = (text: string): string =>
    options.secrets === undefined ? text : options.secrets.redact(text);
  const loc =
    d.range === undefined ? d.file : `${d.file}:${d.range.start.line}:${d.range.start.column}`;
  const lines = [
    `${paint(color, 'bold', loc)}: ${paint(color, 'red', `error[${d.code}]`)}: ${redact(d.message)}`,
  ];
  if (d.range !== undefined) {
    const text = sources.get(d.file);
    if (text !== undefined) lines.push(...codeFrame(text, d.range, color, redact));
  }
  if (d.hint !== undefined) lines.push(`  hint: ${redact(d.hint)}`);
  return lines.join('\n');
}

function codeFrame(
  text: string,
  range: Range,
  color: boolean,
  redact: (text: string) => string,
): string[] {
  const li = new LineIndex(text);
  const startLine = range.start.line;
  const endLine = Math.max(startLine, range.end.line);
  const firstLine = Math.max(1, startLine - 1);
  const lastLine = Math.min(li.lineCount, endLine + 1);
  const width = String(lastLine).length;
  const out: string[] = [];
  for (let ln = firstLine; ln <= lastLine; ln++) {
    const raw = li.lineText(ln);
    const gutter = String(ln).padStart(width, ' ');
    out.push(`  ${paint(color, 'dim', gutter)} | ${redact(raw)}`);
    if (ln === startLine) {
      const caretStart = Math.max(0, range.start.column - 1);
      const caretLen =
        ln === endLine
          ? Math.max(1, range.end.column - range.start.column)
          : Math.max(1, raw.length - caretStart);
      out.push(
        `  ${' '.repeat(width)} | ${' '.repeat(caretStart)}${paint(color, 'red', '^'.repeat(caretLen))}`,
      );
    }
  }
  return out;
}

const ANSI: Readonly<Record<string, readonly [string, string]>> = {
  bold: ['\x1b[1m', '\x1b[22m'],
  red: ['\x1b[31m', '\x1b[39m'],
  dim: ['\x1b[2m', '\x1b[22m'],
};

function paint(color: boolean, style: keyof typeof ANSI, text: string): string {
  if (!color) return text;
  const [open, close] = ANSI[style]!;
  return `${open}${text}${close}`;
}
