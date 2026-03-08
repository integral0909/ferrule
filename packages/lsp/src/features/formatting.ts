import { format } from '@ferrule/script';
import type { DocumentAnalysis } from '../analysis.js';
import type { TextEdit } from '../lspTypes.js';

/** `textDocument/formatting`: a single full-document replacement, or no edits if already canonical. */
export function formatting(analysis: DocumentAnalysis): TextEdit[] {
  const original = analysis.document.text;
  const formatted = format(original);
  if (formatted === original) return [];
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: analysis.document.positionAt(original.length),
      },
      newText: formatted,
    },
  ];
}
