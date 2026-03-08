import { createDefaultRegistry } from '@ferrule/script';
import { AnalysisCache, type DocumentAnalysis } from './analysis.js';
import { codeActions } from './features/codeActions.js';
import { definition, documentHighlight, references, rename } from './features/definition.js';
import { toLspDiagnostics } from './features/diagnostics.js';
import { documentSymbols } from './features/documentSymbols.js';
import { formatting } from './features/formatting.js';
import { completion } from './features/completion.js';
import { hover } from './features/hover.js';
import { SEMANTIC_TOKENS_LEGEND, semanticTokens } from './features/semanticTokens.js';
import { signatureHelp } from './features/signatureHelp.js';
import {
  TextDocumentSyncKind,
  type CodeAction,
  type CodeActionParams,
  type CompletionList,
  type DidChangeTextDocumentParams,
  type DidCloseTextDocumentParams,
  type DidOpenTextDocumentParams,
  type DocumentFormattingParams,
  type DocumentHighlight,
  type DocumentSymbol,
  type DocumentSymbolParams,
  type Hover,
  type InitializeResult,
  type Location,
  type PublishDiagnosticsParams,
  type ReferenceParams,
  type RenameParams,
  type SemanticTokens,
  type SemanticTokensParams,
  type ServerCapabilities,
  type SignatureHelp,
  type TextDocumentPositionParams,
  type TextEdit,
  type WorkspaceEdit,
} from './lspTypes.js';
import { MessageConnection, type Transport } from './protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from './protocol/jsonrpc.js';
import { createTimeoutScheduler, type Scheduler } from './scheduler.js';
import { analyzeScopes, type ScopeAnalysis } from './scopeAnalysis.js';
import { DocumentStore, type TextDocument } from './text/document.js';

const SERVER_NAME = 'ferrule-lsp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_DIAGNOSTICS_DEBOUNCE_MS = 150;

export interface LanguageServerOptions extends Transport {
  /** Overrides the debounce scheduler driving diagnostics republishing after `didChange`. Defaults to real timers. */
  readonly scheduler?: Scheduler;
  /** Debounce window (ms) between the last edit to a document and its diagnostics being republished. */
  readonly diagnosticsDebounceMs?: number;
  /**
   * Called once the `exit` notification is received, with the exit code the LSP spec prescribes
   * (0 if `shutdown` was called first, 1 otherwise). This function never calls `process.exit`
   * itself — `bin.ts` is the only place that decides a process should actually end — so it can be
   * used from tests and embedders without side effects.
   */
  readonly onExit?: (code: number) => void;
  /** Called for a protocol-level problem the connection could not turn into a JSON-RPC response. */
  readonly onError?: (error: unknown) => void;
}

export interface LanguageServer {
  readonly connection: MessageConnection;
  /** Stops the scheduler and connection without waiting for `exit`. Idempotent. */
  dispose(): void;
}

/**
 * Wires every `textDocument/*` handler to the feature modules under `features/`, over a
 * {@link MessageConnection} built from `options.input`/`options.output`. This is the single
 * embedding entry point: `bin.ts` calls it with `process.stdin`/`process.stdout`, and tests call
 * it with in-memory `PassThrough` streams.
 */
export function startLanguageServer(options: LanguageServerOptions): LanguageServer {
  const registry = createDefaultRegistry();
  const documents = new DocumentStore();
  const analysisCache = new AnalysisCache(registry);
  const scopeCache = new WeakMap<DocumentAnalysis, ScopeAnalysis>();
  const scheduler = options.scheduler ?? createTimeoutScheduler();
  const debounceMs = options.diagnosticsDebounceMs ?? DEFAULT_DIAGNOSTICS_DEBOUNCE_MS;
  let shutdownReceived = false;

  const connection = new MessageConnection({
    transport: { input: options.input, output: options.output },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  function getAnalysis(document: TextDocument): DocumentAnalysis {
    return analysisCache.get(document);
  }

  function getScopeAnalysis(analysis: DocumentAnalysis): ScopeAnalysis {
    const cached = scopeCache.get(analysis);
    if (cached !== undefined) return cached;
    const built = analyzeScopes(analysis.parseResult.program);
    scopeCache.set(analysis, built);
    return built;
  }

  function publishDiagnostics(document: TextDocument): void {
    const analysis = getAnalysis(document);
    const params: PublishDiagnosticsParams = {
      uri: document.uri,
      version: document.version,
      diagnostics: toLspDiagnostics(analysis.diagnostics, document.uri, document.source),
    };
    connection.sendNotification('textDocument/publishDiagnostics', params);
  }

  function requireDocument(uri: string): TextDocument {
    const document = documents.get(uri);
    if (document === undefined) {
      throw new ResponseErrorException(ErrorCodes.InvalidParams, `document not open: ${uri}`);
    }
    return document;
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  connection.onRequest('initialize', (): InitializeResult => ({
    capabilities: SERVER_CAPABILITIES,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  }));

  connection.onNotification('initialized', () => {});

  connection.onRequest('shutdown', () => {
    shutdownReceived = true;
    return null;
  });

  connection.onNotification('exit', () => {
    scheduler.dispose();
    const code = shutdownReceived ? 0 : 1;
    connection.dispose();
    options.onExit?.(code);
  });

  // ---- text synchronization -------------------------------------------------------------------

  connection.onNotification('textDocument/didOpen', (rawParams) => {
    const params = rawParams as DidOpenTextDocumentParams;
    const document = documents.open(
      params.textDocument.uri,
      params.textDocument.languageId,
      params.textDocument.version,
      params.textDocument.text,
    );
    publishDiagnostics(document);
  });

  connection.onNotification('textDocument/didChange', (rawParams) => {
    const params = rawParams as DidChangeTextDocumentParams;
    const document = documents.change(
      params.textDocument.uri,
      params.textDocument.version,
      params.contentChanges,
    );
    if (document === undefined) return;
    scheduler.schedule(document.uri, debounceMs, () => publishDiagnostics(document));
  });

  connection.onNotification('textDocument/didClose', (rawParams) => {
    const params = rawParams as DidCloseTextDocumentParams;
    const uri = params.textDocument.uri;
    scheduler.cancel(uri);
    documents.close(uri);
    analysisCache.invalidate(uri);
    const cleared: PublishDiagnosticsParams = { uri, diagnostics: [] };
    connection.sendNotification('textDocument/publishDiagnostics', cleared);
  });

  // ---- language features ----------------------------------------------------------------------

  connection.onRequest('textDocument/hover', (rawParams): Hover | null => {
    const params = rawParams as TextDocumentPositionParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return null;
    const analysis = getAnalysis(document);
    return hover(analysis, getScopeAnalysis(analysis), registry, params.position);
  });

  connection.onRequest('textDocument/completion', (rawParams): CompletionList => {
    const params = rawParams as TextDocumentPositionParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return { isIncomplete: false, items: [] };
    const analysis = getAnalysis(document);
    return completion(analysis, getScopeAnalysis(analysis), registry, params.position);
  });

  connection.onRequest('textDocument/signatureHelp', (rawParams): SignatureHelp | null => {
    const params = rawParams as TextDocumentPositionParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return null;
    return signatureHelp(getAnalysis(document), registry, params.position);
  });

  connection.onRequest('textDocument/definition', (rawParams): Location | null => {
    const params = rawParams as TextDocumentPositionParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return null;
    const analysis = getAnalysis(document);
    return definition(analysis, getScopeAnalysis(analysis), params.position);
  });

  connection.onRequest('textDocument/references', (rawParams): Location[] => {
    const params = rawParams as ReferenceParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const analysis = getAnalysis(document);
    return references(
      analysis,
      getScopeAnalysis(analysis),
      params.position,
      params.context.includeDeclaration,
    );
  });

  connection.onRequest('textDocument/documentHighlight', (rawParams): DocumentHighlight[] => {
    const params = rawParams as TextDocumentPositionParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const analysis = getAnalysis(document);
    return documentHighlight(analysis, getScopeAnalysis(analysis), params.position);
  });

  connection.onRequest('textDocument/rename', (rawParams): WorkspaceEdit => {
    const params = rawParams as RenameParams;
    const document = requireDocument(params.textDocument.uri);
    const analysis = getAnalysis(document);
    return rename(analysis, getScopeAnalysis(analysis), params.position, params.newName);
  });

  connection.onRequest('textDocument/formatting', (rawParams): TextEdit[] => {
    const params = rawParams as DocumentFormattingParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    return formatting(getAnalysis(document));
  });

  connection.onRequest('textDocument/codeAction', (rawParams): CodeAction[] => {
    const params = rawParams as CodeActionParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    return codeActions(getAnalysis(document), params);
  });

  connection.onRequest('textDocument/documentSymbol', (rawParams): DocumentSymbol[] => {
    const params = rawParams as DocumentSymbolParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const analysis = getAnalysis(document);
    return documentSymbols(analysis, getScopeAnalysis(analysis));
  });

  connection.onRequest('textDocument/semanticTokens/full', (rawParams): SemanticTokens => {
    const params = rawParams as SemanticTokensParams;
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return { data: [] };
    const analysis = getAnalysis(document);
    return semanticTokens(analysis, getScopeAnalysis(analysis));
  });

  connection.listen();

  return {
    connection,
    dispose() {
      scheduler.dispose();
      connection.dispose();
    },
  };
}

const SERVER_CAPABILITIES: ServerCapabilities = {
  // The LSP spec requires every client to support UTF-16 position encoding even without
  // negotiating `general/positionEncodings`, and it is also the unit `@ferrule/script`'s own
  // `Span`s already use (see `text/positions.ts`), so there is no reason to advertise anything else.
  positionEncoding: 'utf-16',
  textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
  hoverProvider: true,
  completionProvider: { triggerCharacters: ['.', '%', ',', '('] },
  signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
  definitionProvider: true,
  referencesProvider: true,
  documentHighlightProvider: true,
  renameProvider: true,
  documentFormattingProvider: true,
  codeActionProvider: true,
  documentSymbolProvider: true,
  semanticTokensProvider: { legend: SEMANTIC_TOKENS_LEGEND, full: true },
};
