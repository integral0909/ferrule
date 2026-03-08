/**
 * JSON-RPC 2.0 message shapes and standard/LSP-specific error codes. This is intentionally a
 * small, dependency-free model of the protocol — see `protocol/framing.ts` for the base-protocol
 * byte framing these messages travel over the wire in, and `protocol/connection.ts` for dispatch.
 */

export const JSON_RPC_VERSION = '2.0';

export type MessageId = number | string;

export interface RequestMessage {
  readonly jsonrpc: '2.0';
  readonly id: MessageId;
  readonly method: string;
  readonly params?: unknown;
}

export interface NotificationMessage {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface ResponseError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface ResponseMessage {
  readonly jsonrpc: '2.0';
  readonly id: MessageId | null;
  readonly result?: unknown;
  readonly error?: ResponseError;
}

export type Message = RequestMessage | NotificationMessage | ResponseMessage;

/** Standard JSON-RPC error codes, plus the LSP-specific range reserved from -32899 to -32800. */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  UnknownErrorCode: -32001,
  RequestFailed: -32803,
  ServerCancelled: -32802,
  ContentModified: -32801,
  RequestCancelled: -32800,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Thrown by a request handler to control the exact JSON-RPC error sent back to the client. */
export class ResponseErrorException extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ResponseErrorException';
    this.code = code;
    this.data = data;
  }

  toResponseError(): ResponseError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function isRequestMessage(message: Message): message is RequestMessage {
  return 'method' in message && 'id' in message;
}

export function isNotificationMessage(message: Message): message is NotificationMessage {
  return 'method' in message && !('id' in message);
}

export function isResponseMessage(message: Message): message is ResponseMessage {
  return !('method' in message) && ('result' in message || 'error' in message);
}

/** Narrows an unknown decoded JSON value to a well-formed {@link Message}, or `undefined`. */
export function asMessage(value: unknown): Message | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['jsonrpc'] !== JSON_RPC_VERSION) return undefined;
  const hasMethod = typeof record['method'] === 'string';
  const hasId =
    typeof record['id'] === 'string' || typeof record['id'] === 'number' || record['id'] === null;
  if (hasMethod && hasId) {
    return {
      jsonrpc: '2.0',
      id: record['id'] as MessageId,
      method: record['method'] as string,
      params: record['params'],
    };
  }
  if (hasMethod) {
    return { jsonrpc: '2.0', method: record['method'] as string, params: record['params'] };
  }
  if (hasId && ('result' in record || 'error' in record)) {
    const response: ResponseMessage = { jsonrpc: '2.0', id: record['id'] as MessageId | null };
    return {
      ...response,
      ...('result' in record ? { result: record['result'] } : {}),
      ...('error' in record ? { error: record['error'] as ResponseError } : {}),
    };
  }
  return undefined;
}
