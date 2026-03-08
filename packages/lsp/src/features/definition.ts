import { isKeyword } from '@ferrule/script';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import type { DocumentAnalysis } from '../analysis.js';
import {
  DocumentHighlightKind,
  type DocumentHighlight,
  type Location,
  type Position,
  type WorkspaceEdit,
} from '../lspTypes.js';
import type { ScopeAnalysis, VariableDecl } from '../scopeAnalysis.js';
import { spanToRange } from '../text/positions.js';

/** Resolves the `let`/closure-parameter/pattern-binding under the cursor, from either a use or its declaration site. */
function declAtCursor(scopeAnalysis: ScopeAnalysis, offset: number): VariableDecl | undefined {
  const reference = scopeAnalysis.referenceAt(offset);
  if (reference?.decl !== undefined) return reference.decl;
  return scopeAnalysis.declAt(offset);
}

export function definition(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  position: Position,
): Location | null {
  const decl = declAtCursor(scopeAnalysis, analysis.document.offsetAt(position));
  if (decl === undefined) return null;
  return {
    uri: analysis.document.uri,
    range: spanToRange(analysis.document.source, decl.nameSpan),
  };
}

export function references(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  position: Position,
  includeDeclaration: boolean,
): Location[] {
  const decl = declAtCursor(scopeAnalysis, analysis.document.offsetAt(position));
  if (decl === undefined) return [];
  const source = analysis.document.source;
  const uri = analysis.document.uri;
  const spans = scopeAnalysis.referencesOf(decl).map((r) => r.span);
  if (includeDeclaration) spans.unshift(decl.nameSpan);
  return spans.map((span) => ({ uri, range: spanToRange(source, span) }));
}

export function documentHighlight(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  position: Position,
): DocumentHighlight[] {
  const decl = declAtCursor(scopeAnalysis, analysis.document.offsetAt(position));
  if (decl === undefined) return [];
  const source = analysis.document.source;
  const highlights: DocumentHighlight[] = [
    { range: spanToRange(source, decl.nameSpan), kind: DocumentHighlightKind.Write },
  ];
  for (const ref of scopeAnalysis.referencesOf(decl)) {
    highlights.push({
      range: spanToRange(source, ref.span),
      kind: ref.role === 'write' ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
    });
  }
  return highlights;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `textDocument/rename`. Rejects (via a JSON-RPC `InvalidParams` error, so the client surfaces it
 * as a rename failure rather than silently doing nothing) a `newName` that isn't a valid Ferrule
 * Script identifier, that collides with a reserved keyword, or that already names a different
 * binding declared in the exact same scope as the one being renamed.
 */
export function rename(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  position: Position,
  newName: string,
): WorkspaceEdit {
  if (!IDENTIFIER_RE.test(newName)) {
    throw new ResponseErrorException(
      ErrorCodes.InvalidParams,
      `'${newName}' is not a valid identifier`,
    );
  }
  if (isKeyword(newName)) {
    throw new ResponseErrorException(
      ErrorCodes.InvalidParams,
      `'${newName}' is a reserved keyword`,
    );
  }
  const decl = declAtCursor(scopeAnalysis, analysis.document.offsetAt(position));
  if (decl === undefined) {
    throw new ResponseErrorException(
      ErrorCodes.InvalidParams,
      'there is no renameable symbol at this position',
    );
  }
  if (decl.name === newName) return {};
  const collision = scopeAnalysis.declarations.some(
    (other) => other !== decl && other.scope === decl.scope && other.name === newName,
  );
  if (collision) {
    throw new ResponseErrorException(
      ErrorCodes.InvalidParams,
      `'${newName}' is already declared in the same scope`,
    );
  }

  const source = analysis.document.source;
  const uri = analysis.document.uri;
  const spans = [decl.nameSpan, ...scopeAnalysis.referencesOf(decl).map((r) => r.span)];
  const edits = spans.map((span) => ({ range: spanToRange(source, span), newText: newName }));
  return { changes: { [uri]: edits } };
}
