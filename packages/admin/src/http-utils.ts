import type { IncomingMessage, ServerResponse } from 'node:http';
import { FerruleError } from '@ferrule/core';
import type { Logger } from '@ferrule/runtime';
import {
  AdminError,
  MethodNotAllowedError,
  PayloadTooLargeError,
  RequestTimeoutError,
} from './errors.js';

/** Headers applied to every response: the admin API never wants a browser to sniff content types
 * or cache anything (some responses, like `/config`, can be sensitive even redacted). */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Reads `req`'s body into a `Buffer`, rejecting with {@link PayloadTooLargeError} the moment it
 * would exceed `maxBytes`, so a client can't force unbounded buffering. Deliberately does not
 * `destroy()` the request on overflow — that would tear down the socket before a 413 response
 * could ever reach the client. Removing the `data` listener is enough: an unpiped stream with no
 * listeners auto-pauses, which applies TCP-level backpressure to whatever the client is still
 * sending; the caller is expected to mark the connection non-keep-alive on this error, since the
 * body was never fully drained.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  applySecurityHeaders(res);
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  if (res.writableEnded) return;
  applySecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers?: Readonly<Record<string, string>>,
): void {
  if (res.writableEnded) return;
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }
  sendJson(res, status, { error: { code, message } });
}

/**
 * Maps an error thrown while handling a request to a safe `(status, code, message)` triple.
 * {@link AdminError}s (and other `FerruleError`s, whose messages are written for humans and are
 * safe to surface) pass their code and message through; anything else — a genuine bug — is
 * logged with full detail and reported to the client only as a generic 500, per this project's
 * rule that responses never carry stack traces.
 */
export function describeThrown(
  error: unknown,
  logger: Logger,
): { status: number; code: string; message: string; headers?: Record<string, string> } {
  if (error instanceof MethodNotAllowedError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      headers: { Allow: error.allowed.join(', ') },
    };
  }
  if (error instanceof PayloadTooLargeError || error instanceof RequestTimeoutError) {
    // Neither the client's remaining body (413) nor whatever it does next on a request we gave up
    // on waiting for (408) was fully read; reusing this connection for another request would
    // desync the two sides' view of the stream, so tell the client not to.
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      headers: { Connection: 'close' },
    };
  }
  if (error instanceof AdminError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof FerruleError) {
    return { status: 400, code: error.code, message: error.message };
  }
  logger.error('admin request failed', {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  return { status: 500, code: 'E_INTERNAL', message: 'internal server error' };
}
