import { formatPath } from '@ferrule/core';
import {
  formatExprType,
  formatType,
  KEYWORDS,
  lex,
  walkProgram,
  type FunctionRegistry,
  type FunctionSignature,
  type Span,
} from '@ferrule/script';
import { findEnclosingCall } from '../astUtil.js';
import type { DocumentAnalysis } from '../analysis.js';
import { formatSignatureMarkdown } from '../functionSignatures.js';
import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
  type CompletionList,
  type Position,
} from '../lspTypes.js';
import type { ScopeAnalysis } from '../scopeAnalysis.js';
import { spanToRange } from '../text/positions.js';
import { variableExprType } from '../variableInfo.js';

const METADATA_PATHS = ['%source_id', '%source_type', '%received_at'] as const;

type CompletionContext =
  | { readonly kind: 'path'; readonly tokenSpan: Span }
  | { readonly kind: 'metadataPath'; readonly tokenSpan: Span }
  | { readonly kind: 'general' };

/**
 * `textDocument/completion`: stdlib functions (snippet params + docs), in-scope `let` variables,
 * keywords, and — after `.`/`%` — field paths seen elsewhere in the document. Inside a call's
 * argument list, named parameters of the resolved function are added as well.
 */
export function completion(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  registry: FunctionRegistry,
  position: Position,
): CompletionList {
  const offset = analysis.document.offsetAt(position);
  const context = detectContext(analysis, offset);
  const items: CompletionItem[] = [];

  if (context.kind === 'metadataPath') {
    const range = spanToRange(analysis.document.source, context.tokenSpan);
    for (const name of METADATA_PATHS) {
      items.push({
        label: name,
        kind: CompletionItemKind.Field,
        detail: 'metadata path',
        textEdit: { range, newText: name },
      });
    }
    return { isIncomplete: false, items };
  }

  if (context.kind === 'path') {
    items.push(...pathCompletions(analysis, context.tokenSpan));
    return { isIncomplete: false, items: dedupeByLabel(items) };
  }

  items.push(...keywordCompletions());
  items.push(...variableCompletions(analysis, scopeAnalysis, offset));
  items.push(...functionCompletions(registry));
  items.push(...namedParameterCompletions(analysis, registry, offset));

  return { isIncomplete: false, items: dedupeByLabel(items) };
}

function detectContext(analysis: DocumentAnalysis, offset: number): CompletionContext {
  const { tokens } = lex(analysis.document.source);
  for (const { token } of tokens) {
    if (offset < token.span.start || offset > token.span.end) continue;
    if (token.kind === 'path') return { kind: 'path', tokenSpan: token.span };
    if (token.kind === 'metadataPath') return { kind: 'metadataPath', tokenSpan: token.span };
  }
  return { kind: 'general' };
}

function keywordCompletions(): CompletionItem[] {
  return KEYWORDS.map((kw) => ({ label: kw, kind: CompletionItemKind.Keyword }));
}

function variableCompletions(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  offset: number,
): CompletionItem[] {
  return scopeAnalysis.visibleAt(offset).map((decl) => {
    const exprType = variableExprType(decl, analysis.checkResult, scopeAnalysis);
    return {
      label: decl.name,
      kind: CompletionItemKind.Variable,
      ...(exprType === undefined ? {} : { detail: formatExprType(exprType) }),
    };
  });
}

function functionCompletions(registry: FunctionRegistry): CompletionItem[] {
  return registry.all().map((sig) => ({
    label: sig.name,
    kind: CompletionItemKind.Function,
    detail: signatureSummary(sig),
    documentation: formatSignatureMarkdown(sig),
    insertText: buildCallSnippet(sig),
    insertTextFormat: InsertTextFormat.Snippet,
  }));
}

function namedParameterCompletions(
  analysis: DocumentAnalysis,
  registry: FunctionRegistry,
  offset: number,
): CompletionItem[] {
  const call = findEnclosingCall(analysis.parseResult.program, offset);
  if (call === undefined || call.callee.kind !== 'identifier') return [];
  const resolved = analysis.checkResult.calls.get(call);
  const signature = resolved?.signature ?? registry.get(call.callee.name);
  if (signature === undefined) return [];
  const supplied = new Set(call.args.filter((a) => a.kind === 'named').map((a) => a.name));
  return signature.params
    .filter((p) => p.namedOnly && !supplied.has(p.name))
    .map((p) => ({
      label: `${p.name}:`,
      kind: CompletionItemKind.Field,
      detail: formatType(p.type),
      insertText: `${p.name}: \${1}`,
      insertTextFormat: InsertTextFormat.Snippet,
    }));
}

function pathCompletions(analysis: DocumentAnalysis, tokenSpan: Span): CompletionItem[] {
  const range = spanToRange(analysis.document.source, tokenSpan);
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  walkProgram(analysis.parseResult.program, (node) => {
    if (node.kind !== 'path') return;
    if (node.span.start >= tokenSpan.start && node.span.end <= tokenSpan.end) return; // the token being typed itself
    const text = formatPath(node.segments);
    if (text === '.' || seen.has(text)) return;
    seen.add(text);
    items.push({
      label: text,
      kind: CompletionItemKind.Field,
      detail: 'event path',
      textEdit: { range, newText: text },
    });
  });
  return items;
}

function signatureSummary(sig: FunctionSignature): string {
  const returnType = typeof sig.returnType === 'function' ? 'any' : formatType(sig.returnType);
  return `(${sig.params.length} param${sig.params.length === 1 ? '' : 's'}) -> ${returnType}`;
}

function buildCallSnippet(sig: FunctionSignature): string {
  let index = 1;
  const parts: string[] = [];
  for (const p of sig.params) {
    if (p.optional) continue;
    const placeholder = `\${${index}:${p.name}}`;
    index++;
    parts.push(p.namedOnly ? `${p.name}: ${placeholder}` : placeholder);
  }
  return `${sig.name}(${parts.join(', ')})`;
}

function dedupeByLabel(items: readonly CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];
  for (const item of items) {
    const key = `${item.kind ?? 0}:${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
