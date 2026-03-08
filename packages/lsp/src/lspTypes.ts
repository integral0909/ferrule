/**
 * A minimal, hand-written subset of the Language Server Protocol 3.17 wire types — just what this
 * server's capabilities (see `server.ts`) actually produce or consume. Not a general-purpose LSP
 * type library: there is no `vscode-languageserver-types` dependency (the task calls for
 * implementing the protocol directly), so only the shapes this package needs are declared here.
 */

export type { Position, Range } from './text/positions.js';
import type { Position, Range } from './text/positions.js';

export interface TextDocumentIdentifier {
  readonly uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  readonly version: number;
}

export interface TextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

export interface TextDocumentPositionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

// ---- diagnostics ----------------------------------------------------------------------------

export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;
export type DiagnosticSeverityValue = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface DiagnosticRelatedInformation {
  readonly location: Location;
  readonly message: string;
}

export interface LspDiagnostic {
  readonly range: Range;
  readonly severity: DiagnosticSeverityValue;
  readonly code: string;
  readonly source: 'ferrule';
  readonly message: string;
  readonly relatedInformation?: readonly DiagnosticRelatedInformation[];
  /** Round-tripped back on `codeAction` requests so quick fixes don't need to re-run the checker. */
  readonly data?: { readonly fixes: readonly LspFix[] };
}

export interface LspFix {
  readonly description: string;
  readonly edits: readonly TextEdit[];
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly LspDiagnostic[];
}

// ---- text edits / workspace edits -------------------------------------------------------------

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

export interface WorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly TextEdit[]>>;
}

// ---- hover ------------------------------------------------------------------------------------

export interface MarkupContent {
  readonly kind: 'plaintext' | 'markdown';
  readonly value: string;
}

export interface Hover {
  readonly contents: MarkupContent;
  readonly range?: Range;
}

// ---- completion ---------------------------------------------------------------------------------

export const CompletionItemKind = {
  Text: 1,
  Function: 3,
  Field: 5,
  Variable: 6,
  Value: 12,
  Keyword: 14,
  Snippet: 15,
} as const;
export type CompletionItemKindValue = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];

export const InsertTextFormat = {
  PlainText: 1,
  Snippet: 2,
} as const;
export type InsertTextFormatValue = (typeof InsertTextFormat)[keyof typeof InsertTextFormat];

export interface CompletionItem {
  readonly label: string;
  readonly kind?: CompletionItemKindValue;
  readonly detail?: string;
  readonly documentation?: MarkupContent;
  readonly insertText?: string;
  readonly insertTextFormat?: InsertTextFormatValue;
  readonly sortText?: string;
  readonly filterText?: string;
  /**
   * An explicit replacement, used instead of `insertText` when the text to replace isn't just the
   * word under the cursor — e.g. completing `.status` while the cursor sits inside an
   * already-typed `.st` path token, where the whole token (not just `st`) must be replaced.
   */
  readonly textEdit?: TextEdit;
}

export interface CompletionList {
  readonly isIncomplete: boolean;
  readonly items: readonly CompletionItem[];
}

// ---- signature help -----------------------------------------------------------------------------

export interface ParameterInformation {
  readonly label: string;
  readonly documentation?: MarkupContent;
}

export interface SignatureInformation {
  readonly label: string;
  readonly documentation?: MarkupContent;
  readonly parameters?: readonly ParameterInformation[];
  readonly activeParameter?: number;
}

export interface SignatureHelp {
  readonly signatures: readonly SignatureInformation[];
  readonly activeSignature?: number;
  readonly activeParameter?: number;
}

// ---- document highlight / references ----------------------------------------------------------

export const DocumentHighlightKind = {
  Text: 1,
  Read: 2,
  Write: 3,
} as const;
export type DocumentHighlightKindValue =
  (typeof DocumentHighlightKind)[keyof typeof DocumentHighlightKind];

export interface DocumentHighlight {
  readonly range: Range;
  readonly kind?: DocumentHighlightKindValue;
}

export interface ReferenceParams extends TextDocumentPositionParams {
  readonly context: { readonly includeDeclaration: boolean };
}

// ---- rename ---------------------------------------------------------------------------------

export interface RenameParams extends TextDocumentPositionParams {
  readonly newName: string;
}

// ---- document symbols -----------------------------------------------------------------------

export const SymbolKind = {
  Function: 12,
  Variable: 13,
} as const;
export type SymbolKindValue = (typeof SymbolKind)[keyof typeof SymbolKind];

export interface DocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: SymbolKindValue;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

// ---- code actions -------------------------------------------------------------------------------

export interface CodeActionContext {
  readonly diagnostics: readonly LspDiagnostic[];
}

export interface CodeActionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly range: Range;
  readonly context: CodeActionContext;
}

export interface CodeAction {
  readonly title: string;
  readonly kind: 'quickfix';
  readonly diagnostics?: readonly LspDiagnostic[];
  readonly edit: WorkspaceEdit;
  readonly isPreferred?: boolean;
}

// ---- semantic tokens ------------------------------------------------------------------------

export interface SemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

export interface SemanticTokens {
  readonly data: readonly number[];
}

// ---- lifecycle / capabilities -----------------------------------------------------------------

export interface InitializeParams {
  readonly processId?: number | null;
  readonly rootUri?: string | null;
  readonly capabilities?: unknown;
  readonly [key: string]: unknown;
}

export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;
export type TextDocumentSyncKindValue =
  (typeof TextDocumentSyncKind)[keyof typeof TextDocumentSyncKind];

export interface ServerCapabilities {
  readonly positionEncoding: 'utf-16';
  readonly textDocumentSync: {
    readonly openClose: boolean;
    readonly change: TextDocumentSyncKindValue;
  };
  readonly hoverProvider: boolean;
  readonly completionProvider: { readonly triggerCharacters: readonly string[] };
  readonly signatureHelpProvider: {
    readonly triggerCharacters: readonly string[];
    readonly retriggerCharacters: readonly string[];
  };
  readonly definitionProvider: boolean;
  readonly referencesProvider: boolean;
  readonly documentHighlightProvider: boolean;
  readonly renameProvider: boolean;
  readonly documentFormattingProvider: boolean;
  readonly codeActionProvider: boolean;
  readonly documentSymbolProvider: boolean;
  readonly semanticTokensProvider: {
    readonly legend: SemanticTokensLegend;
    readonly full: boolean;
  };
}

export interface InitializeResult {
  readonly capabilities: ServerCapabilities;
  readonly serverInfo: { readonly name: string; readonly version: string };
}

// ---- didOpen/didChange/didClose params --------------------------------------------------------

export interface DidOpenTextDocumentParams {
  readonly textDocument: TextDocumentItem;
}

export interface DidCloseTextDocumentParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface TextDocumentContentChangeEventParam {
  readonly range?: Range;
  readonly rangeLength?: number;
  readonly text: string;
}

export interface DidChangeTextDocumentParams {
  readonly textDocument: VersionedTextDocumentIdentifier;
  readonly contentChanges: readonly TextDocumentContentChangeEventParam[];
}

export interface DocumentFormattingParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface DocumentSymbolParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface SemanticTokensParams {
  readonly textDocument: TextDocumentIdentifier;
}
