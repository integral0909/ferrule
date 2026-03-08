/**
 * JSON-RPC 2.0 request/notification dispatch over a framed byte stream (`framing.ts`), plus
 * `$/cancelRequest` support (`cancellation.ts`). This is the transport-agnostic core the language
 * server (`server.ts`) is built on: it knows nothing about LSP methods, only how to route
 * messages to handlers and turn handler results/throws into well-formed responses.
 */

import {
  CancellationError,
  CancellationTokenSource,
  type CancellationToken,
} from './cancellation.js';
import { encodeFrame, FrameDecoder } from './framing.js';
import {
  asMessage,
  ErrorCodes,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  ResponseErrorException,
  type Message,
  type MessageId,
  type NotificationMessage,
  type RequestMessage,
  type ResponseMessage,
} from './jsonrpc.js';

/** A duplex byte-stream pair a {@link MessageConnection} reads requests from and writes replies to. */
export interface Transport {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export type RequestHandler = (params: unknown, token: CancellationToken) => unknown;
export type NotificationHandler = (params: unknown) => void;

export interface MessageConnectionOptions {
  readonly transport: Transport;
  /**
   * Called for a problem that cannot be reported as a JSON-RPC response: a malformed incoming
   * frame, an exception from a notification handler (notifications have no id to reply to), or an
   * internal-error response the connection is about to send (so a caller can still observe/log
   * it). Defaults to a no-op — the connection never writes to stdout/stderr on its own, since
   * stdout is the message channel itself.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * Reads framed JSON-RPC messages from `transport.input`, dispatches requests/notifications to
 * registered handlers, and writes framed responses (and, for {@link sendRequest}/
 * {@link sendNotification}, server-initiated messages) to `transport.output`.
 */
export class MessageConnection {
  private readonly transport: Transport;
  private readonly onError: (error: unknown) => void;
  private readonly decoder = new FrameDecoder();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pendingCancellation = new Map<MessageId, CancellationTokenSource>();
  private readonly pendingOutgoing = new Map<
    MessageId,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private nextOutgoingId = 1;
  private disposed = false;
  private listening = false;
  private readonly dataListener = (chunk: Buffer | string): void => this.handleChunk(chunk);

  constructor(options: MessageConnectionOptions) {
    this.transport = options.transport;
    this.onError = options.onError ?? (() => {});
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Starts reading `transport.input`. Idempotent. */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.transport.input.on('data', this.dataListener);
  }

  /** Stops reading input and rejects any requests this connection has outstanding. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.input.off('data', this.dataListener);
    for (const pending of this.pendingOutgoing.values()) {
      pending.reject(new Error('connection disposed before a response arrived'));
    }
    this.pendingOutgoing.clear();
    for (const source of this.pendingCancellation.values()) source.cancel();
    this.pendingCancellation.clear();
  }

  sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Sends a server-initiated request to the client and resolves with its result. */
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextOutgoingId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingOutgoing.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  private write(message: Message): void {
    if (this.disposed) return;
    this.transport.output.write(encodeFrame(message));
  }

  private handleChunk(chunk: Buffer | string): void {
    let decoded: unknown[];
    try {
      decoded = this.decoder.push(chunk);
    } catch (error) {
      this.onError(error);
      return;
    }
    for (const value of decoded) this.handleMessage(value);
  }

  private handleMessage(value: unknown): void {
    const message = asMessage(value);
    if (message === undefined) {
      this.onError(new Error(`malformed JSON-RPC message: ${JSON.stringify(value)}`));
      return;
    }
    if (isRequestMessage(message)) {
      void this.handleRequest(message);
    } else if (isNotificationMessage(message)) {
      this.handleNotification(message);
    } else if (isResponseMessage(message)) {
      this.handleResponse(message);
    }
  }

  private handleNotification(message: NotificationMessage): void {
    if (message.method === '$/cancelRequest') {
      const params = message.params as { id?: MessageId } | undefined;
      if (params?.id !== undefined) this.pendingCancellation.get(params.id)?.cancel();
      return;
    }
    const handler = this.notificationHandlers.get(message.method);
    if (handler === undefined) return; // unhandled notifications are silently ignored, per spec
    try {
      handler(message.params);
    } catch (error) {
      this.onError(error);
    }
  }

  private async handleRequest(message: RequestMessage): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (handler === undefined) {
      this.write(
        errorResponse(message.id, ErrorCodes.MethodNotFound, `method not found: ${message.method}`),
      );
      return;
    }
    const source = new CancellationTokenSource();
    this.pendingCancellation.set(message.id, source);
    try {
      const result = await handler(message.params, source.token);
      if (source.token.isCancellationRequested) {
        this.write(errorResponse(message.id, ErrorCodes.RequestCancelled, 'request cancelled'));
        return;
      }
      this.write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? null : result });
    } catch (error) {
      this.handleRequestError(message.id, source.token, error);
    } finally {
      this.pendingCancellation.delete(message.id);
    }
  }

  private handleRequestError(id: MessageId, token: CancellationToken, error: unknown): void {
    if (error instanceof CancellationError || token.isCancellationRequested) {
      this.write(errorResponse(id, ErrorCodes.RequestCancelled, 'request cancelled'));
      return;
    }
    if (error instanceof ResponseErrorException) {
      this.write({ jsonrpc: '2.0', id, error: error.toResponseError() });
      return;
    }
    this.onError(error);
    this.write(errorResponse(id, ErrorCodes.InternalError, describeError(error)));
  }

  private handleResponse(message: ResponseMessage): void {
    if (message.id === null) return;
    const pending = this.pendingOutgoing.get(message.id);
    if (pending === undefined) return;
    this.pendingOutgoing.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        new ResponseErrorException(message.error.code, message.error.message, message.error.data),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}

function errorResponse(id: MessageId, code: number, message: string): ResponseMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
