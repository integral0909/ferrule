import { walkProgram } from '@ferrule/script';
import type { DocumentAnalysis } from '../analysis.js';
import { SymbolKind, type DocumentSymbol } from '../lspTypes.js';
import type { ScopeAnalysis } from '../scopeAnalysis.js';
import { spanToRange } from '../text/positions.js';
import { variableKindLabel } from '../variableInfo.js';

/** `textDocument/documentSymbol`: every `let`/`let mut`/`let v, err`/pattern binding, and every `test`. */
export function documentSymbols(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
): DocumentSymbol[] {
  const source = analysis.document.source;
  const entries: { readonly start: number; readonly symbol: DocumentSymbol }[] = [];

  for (const decl of scopeAnalysis.declarations) {
    const range = spanToRange(source, decl.nameSpan);
    entries.push({
      start: decl.nameSpan.start,
      symbol: {
        name: decl.name,
        detail: variableKindLabel(decl.kind),
        kind: SymbolKind.Variable,
        range,
        selectionRange: range,
      },
    });
  }

  walkProgram(analysis.parseResult.program, (node) => {
    if (node.kind !== 'test') return;
    entries.push({
      start: node.span.start,
      symbol: {
        name: node.name,
        detail: 'test',
        kind: SymbolKind.Function,
        range: spanToRange(source, node.span),
        selectionRange: spanToRange(source, node.nameSpan),
      },
    });
  });

  return entries.sort((a, b) => a.start - b.start).map((e) => e.symbol);
}
