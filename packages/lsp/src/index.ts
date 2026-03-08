/**
 * `@ferrule/lsp`: a Language Server Protocol implementation for Ferrule Script, built entirely on
 * the Node.js standard library (no `vscode-languageserver*` dependency). See the package README
 * for capabilities and editor setup.
 *
 * The primary entry point is {@link startLanguageServer}, which wires a JSON-RPC connection over
 * any pair of Node streams (`process.stdin`/`process.stdout` for the `ferrule-lsp` executable in
 * `bin.ts`, or in-memory `PassThrough` streams for embedding/tests) to every `textDocument/*`
 * handler this package implements.
 */

export { startLanguageServer, type LanguageServer, type LanguageServerOptions } from './server.js';

// ---- JSON-RPC / base protocol (for embedders that want the transport without the LSP layer) ----

export {
  MessageConnection,
  type MessageConnectionOptions,
  type NotificationHandler,
  type RequestHandler,
  type Transport,
} from './protocol/connection.js';

export { encodeFrame, FrameDecoder, FramingError } from './protocol/framing.js';

export {
  asMessage,
  ErrorCodes,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  JSON_RPC_VERSION,
  ResponseErrorException,
  type Message,
  type MessageId,
  type NotificationMessage,
  type RequestMessage,
  type ResponseError,
  type ResponseMessage,
} from './protocol/jsonrpc.js';

export {
  CancellationError,
  CancellationTokenSource,
  CancellationToken_None,
  type CancellationToken,
} from './protocol/cancellation.js';

// ---- scheduling (for tests/embedders that want deterministic diagnostics timing) ---------------

export {
  createImmediateScheduler,
  createTimeoutScheduler,
  ManualScheduler,
  type Scheduler,
} from './scheduler.js';

// ---- document/text model -----------------------------------------------------------------------

export {
  DocumentStore,
  TextDocument,
  type TextDocumentContentChangeEvent,
} from './text/document.js';

export {
  comparePositions,
  containsPosition,
  offsetToPosition,
  pointRange,
  positionToOffset,
  rangeToSpan,
  spanToRange,
} from './text/positions.js';

export { analyzeDocument, AnalysisCache, type DocumentAnalysis } from './analysis.js';

export {
  analyzeScopes,
  type ScopeAnalysis,
  type ScopeNode,
  type VariableDecl,
  type VariableDeclKind,
  type VariableReference,
} from './scopeAnalysis.js';

// ---- wire types ---------------------------------------------------------------------------------

export * from './lspTypes.js';
