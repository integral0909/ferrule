import type { DocumentAnalysis } from '../analysis.js';
import type { CodeAction, CodeActionParams, Range } from '../lspTypes.js';
import { comparePositions } from '../text/positions.js';

/** `textDocument/codeAction`: quick fixes built straight from the diagnostics' own suggested fixes. */
export function codeActions(analysis: DocumentAnalysis, params: CodeActionParams): CodeAction[] {
  const uri = analysis.document.uri;
  const actions: CodeAction[] = [];
  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.data === undefined) continue;
    if (!rangesOverlap(diagnostic.range, params.range)) continue;
    const fixes = diagnostic.data.fixes;
    for (const fix of fixes) {
      actions.push({
        title: fix.description,
        kind: 'quickfix',
        diagnostics: [diagnostic],
        edit: { changes: { [uri]: fix.edits } },
        isPreferred: fixes.length === 1,
      });
    }
  }
  return actions;
}

function rangesOverlap(a: Range, b: Range): boolean {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0;
}
