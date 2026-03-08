import {
  isKeyword,
  lex,
  walkProgram,
  type CommentTrivia,
  type SourceFile,
  type Span,
  type Token,
} from '@ferrule/script';
import type { DocumentAnalysis } from '../analysis.js';
import type { SemanticTokens, SemanticTokensLegend } from '../lspTypes.js';
import type { ScopeAnalysis, VariableDecl } from '../scopeAnalysis.js';

/**
 * `textDocument/semanticTokens/full`. Ferrule Script ships no TextMate/tree-sitter grammar of its
 * own, so semantic tokens are the primary syntax-highlighting mechanism an editor has for it:
 * keywords and literals come straight from the lexer's token stream (`lex`, which never throws,
 * so this works even on a currently-invalid document); variable/parameter/function classification
 * for identifiers comes from {@link ScopeAnalysis} and the call sites `walkProgram` finds.
 */
export const SEMANTIC_TOKEN_TYPES = [
  'keyword',
  'function',
  'parameter',
  'variable',
  'property',
  'string',
  'number',
  'regexp',
  'comment',
  'operator',
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'readonly'] as const;

const DECLARATION_BIT = 1 << 0;
const READONLY_BIT = 1 << 1;

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: SEMANTIC_TOKEN_TYPES,
  tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
};

type TokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];
const TYPE_INDEX = new Map<TokenType, number>(SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i]));

const OPERATOR_KINDS: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '&&',
  '||',
  '??',
  '!',
  '=',
  '=>',
]);

interface RawToken {
  readonly span: Span;
  readonly type: TokenType;
  readonly modifiers: number;
}

export function semanticTokens(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
): SemanticTokens {
  const source = analysis.document.source;
  const { tokens } = lex(source);

  const declByStart = new Map<number, VariableDecl>();
  for (const decl of scopeAnalysis.declarations) declByStart.set(decl.nameSpan.start, decl);
  const refByStart = new Map<number, VariableDecl>();
  for (const ref of scopeAnalysis.references) {
    if (ref.decl !== undefined) refByStart.set(ref.span.start, ref.decl);
  }
  const calleeStarts = new Set<number>();
  walkProgram(analysis.parseResult.program, (node) => {
    if (node.kind === 'call' && node.callee.kind === 'identifier') {
      calleeStarts.add(node.callee.span.start);
    }
  });

  const raw: RawToken[] = [];
  for (const { token, leadingComments, trailingComment } of tokens) {
    for (const comment of leadingComments) raw.push(commentToken(comment));
    const classified = classify(token, declByStart, refByStart, calleeStarts);
    if (classified !== undefined) raw.push(classified);
    if (trailingComment !== undefined) raw.push(commentToken(trailingComment));
  }
  raw.sort((a, b) => a.span.start - b.span.start);

  return { data: encode(raw, source) };
}

function commentToken(comment: CommentTrivia): RawToken {
  return { span: comment.span, type: 'comment', modifiers: 0 };
}

function variableModifiers(decl: VariableDecl): number {
  return decl.mutable ? 0 : READONLY_BIT;
}

function classify(
  token: Token,
  declByStart: ReadonlyMap<number, VariableDecl>,
  refByStart: ReadonlyMap<number, VariableDecl>,
  calleeStarts: ReadonlySet<number>,
): RawToken | undefined {
  if (isKeyword(token.kind)) return { span: token.span, type: 'keyword', modifiers: 0 };
  switch (token.kind) {
    case 'string':
    case 'rawString':
    case 'byteString':
    case 'timestamp':
      return { span: token.span, type: 'string', modifiers: 0 };
    case 'int':
    case 'float':
      return { span: token.span, type: 'number', modifiers: 0 };
    case 'regex':
      return { span: token.span, type: 'regexp', modifiers: 0 };
    case 'path':
    case 'metadataPath':
      return { span: token.span, type: 'property', modifiers: 0 };
    case 'identifier': {
      const decl = declByStart.get(token.span.start);
      if (decl !== undefined) {
        const type: TokenType = decl.kind === 'closureParam' ? 'parameter' : 'variable';
        return { span: token.span, type, modifiers: DECLARATION_BIT | variableModifiers(decl) };
      }
      if (calleeStarts.has(token.span.start)) {
        return { span: token.span, type: 'function', modifiers: 0 };
      }
      const refDecl = refByStart.get(token.span.start);
      if (refDecl !== undefined) {
        const type: TokenType = refDecl.kind === 'closureParam' ? 'parameter' : 'variable';
        return { span: token.span, type, modifiers: variableModifiers(refDecl) };
      }
      return { span: token.span, type: 'variable', modifiers: 0 };
    }
    default:
      return OPERATOR_KINDS.has(token.kind)
        ? { span: token.span, type: 'operator', modifiers: 0 }
        : undefined;
  }
}

interface LinePiece {
  readonly line: number;
  readonly char: number;
  readonly length: number;
}

/** Splits a (usually single-line) span into per-line pieces — semantic tokens may not span lines. */
function splitByLine(span: Span, source: SourceFile): LinePiece[] {
  const start = source.lineColumnAt(span.start);
  const end = source.lineColumnAt(span.end);
  if (start.line === end.line) {
    return [{ line: start.line - 1, char: start.column - 1, length: span.end - span.start }];
  }
  const pieces: LinePiece[] = [];
  for (let line = start.line; line <= end.line; line++) {
    const lineStart = source.lineStart(line);
    const lineEndOffset = source.lineEnd(line);
    const segStart = line === start.line ? span.start : lineStart;
    const segEnd = line === end.line ? span.end : lineEndOffset;
    if (segEnd <= segStart) continue;
    pieces.push({ line: line - 1, char: segStart - lineStart, length: segEnd - segStart });
  }
  return pieces;
}

function encode(raw: readonly RawToken[], source: SourceFile): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const token of raw) {
    const typeIndex = TYPE_INDEX.get(token.type)!;
    for (const piece of splitByLine(token.span, source)) {
      const deltaLine = piece.line - prevLine;
      const deltaChar = deltaLine === 0 ? piece.char - prevChar : piece.char;
      data.push(deltaLine, deltaChar, piece.length, typeIndex, token.modifiers);
      prevLine = piece.line;
      prevChar = piece.char;
    }
  }
  return data;
}
