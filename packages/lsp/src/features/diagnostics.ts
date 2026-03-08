import type { Diagnostic as FerruleDiagnostic, SourceFile } from '@ferrule/script';
import {
  DiagnosticSeverity,
  type DiagnosticRelatedInformation,
  type DiagnosticSeverityValue,
  type LspDiagnostic,
  type LspFix,
} from '../lspTypes.js';
import { spanToRange } from '../text/positions.js';

/** Maps Ferrule Script's own `Diagnostic`s (from `parse`/`check`) to `textDocument/publishDiagnostics` form. */
export function toLspDiagnostics(
  diagnostics: readonly FerruleDiagnostic[],
  uri: string,
  source: SourceFile,
): LspDiagnostic[] {
  return diagnostics.map((d) => toLspDiagnostic(d, uri, source));
}

function toLspDiagnostic(
  diagnostic: FerruleDiagnostic,
  uri: string,
  source: SourceFile,
): LspDiagnostic {
  const relatedInformation: DiagnosticRelatedInformation[] = diagnostic.secondary.map((label) => ({
    location: { uri, range: spanToRange(source, label.span) },
    message: label.message,
  }));
  const message =
    diagnostic.notes.length === 0
      ? diagnostic.message
      : `${diagnostic.message}\n${diagnostic.notes.map((note) => `note: ${note}`).join('\n')}`;
  const fixes: LspFix[] = diagnostic.fixes.map((fix) => ({
    description: fix.description,
    edits: fix.edits.map((edit) => ({
      range: spanToRange(source, edit.span),
      newText: edit.newText,
    })),
  }));

  return {
    range: spanToRange(source, diagnostic.primary.span),
    severity: toSeverity(diagnostic.severity),
    code: diagnostic.code,
    source: 'ferrule',
    message,
    ...(relatedInformation.length > 0 ? { relatedInformation } : {}),
    ...(fixes.length > 0 ? { data: { fixes } } : {}),
  };
}

function toSeverity(severity: FerruleDiagnostic['severity']): DiagnosticSeverityValue {
  switch (severity) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    case 'note':
      return DiagnosticSeverity.Information;
  }
}
