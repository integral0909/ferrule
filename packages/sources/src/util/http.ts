/**
 * Shared plumbing for the HTTP-based sources (`http_server`, `otlp`): request-body reading with
 * bounded, zip-bomb-safe decompression, authentication (constant-time comparison), TLS server
 * options, and small response helpers. Kept here so both sources implement these once, the same
 * way.
 */
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TlsOptions as NodeTlsOptions } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { FerruleError } from '@ferrule/core';
import { isAbortError } from '@ferrule/runtime';
import type { AuthOptions, TlsOptions } from '../fragments.js';

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

export class PayloadTooLargeError extends FerruleError {
  constructor(
    readonly limitBytes: number,
    readonly which: 'compressed' | 'decompressed',
  ) {
    super('E_PAYLOAD_TOO_LARGE', `request body exceeds the ${limitBytes}-byte ${which} limit`);
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsupportedContentEncodingError extends FerruleError {
  constructor(readonly encoding: string) {
    super(
      'E_UNSUPPORTED_CONTENT_ENCODING',
      `unsupported Content-Encoding ${JSON.stringify(encoding)}`,
    );
    this.name = 'UnsupportedContentEncodingError';
  }
}

// -------------------------------------------------------------------------------------------
// Body reading with bounded decompression
// -------------------------------------------------------------------------------------------

export type ContentEncoding = 'identity' | 'gzip' | 'deflate' | 'br';

/** Parses a `Content-Encoding` header value. `undefined` means the encoding is not recognised. */
export function parseContentEncoding(
  header: string | string[] | undefined,
): ContentEncoding | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.trim() === '') return 'identity';
  switch (value.trim().toLowerCase()) {
    case 'identity':
      return 'identity';
    case 'gzip':
    case 'x-gzip':
      return 'gzip';
    case 'deflate':
      return 'deflate';
    case 'br':
      return 'br';
    default:
      return undefined;
  }
}

/** A `Transform` that fails the stream once more than `limitBytes` have passed through it. This
 * is what bounds decompression output regardless of the input's compression ratio: a zip-bomb
 * upload is destroyed as soon as its *decompressed* size crosses the limit, not after it has
 * been fully inflated into memory. */
class ByteLimitTransform extends Transform {
  private total = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly which: 'compressed' | 'decompressed',
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.limitBytes) {
      callback(new PayloadTooLargeError(this.limitBytes, this.which));
      return;
    }
    callback(null, chunk);
  }
}

function createDecompressor(encoding: Exclude<ContentEncoding, 'identity'>): Transform {
  switch (encoding) {
    case 'gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
  }
}

export interface ReadLimitedBodyOptions {
  readonly encoding: ContentEncoding;
  /** Limit on the effective (decompressed) body size. */
  readonly maxBytes: number;
  /** Limit on bytes read off the wire, before decompression. Defaults to `maxBytes`. */
  readonly maxCompressedBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * Reads a request body to completion, decompressing it if `encoding` requires it, and rejects
 * with {@link PayloadTooLargeError} as soon as either the wire size or the decompressed size
 * crosses its limit — the stream is torn down immediately rather than buffered further.
 */
export async function readLimitedBody(
  req: IncomingMessage,
  options: ReadLimitedBodyOptions,
): Promise<Buffer> {
  const maxCompressed = options.maxCompressedBytes ?? options.maxBytes;
  const wireLimiter = new ByteLimitTransform(maxCompressed, 'compressed');
  const stages: NodeJS.ReadWriteStream[] =
    options.encoding === 'identity'
      ? [wireLimiter, new ByteLimitTransform(options.maxBytes, 'decompressed')]
      : [
          wireLimiter,
          createDecompressor(options.encoding),
          new ByteLimitTransform(options.maxBytes, 'decompressed'),
        ];

  const chunks: Buffer[] = [];
  const collector = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      chunks.push(chunk);
      callback();
    },
  });

  try {
    if (options.signal !== undefined) {
      await pipeline(req, ...(stages as [NodeJS.ReadWriteStream]), collector, {
        signal: options.signal,
      });
    } else {
      await pipeline(req, ...(stages as [NodeJS.ReadWriteStream]), collector);
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    if (isAbortError(error)) throw error;
    throw new FerruleError('E_REQUEST_BODY_READ', 'failed to read the request body', {
      cause: error,
    });
  }
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------------------------

export type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

/** Constant-time string comparison (by content, not just length) to avoid timing side channels
 * on token/password comparisons. A length mismatch is checked first — leaking the *length* of a
 * secret is a far smaller concern than leaking which prefix of it is correct character-by-character,
 * and Node's `timingSafeEqual` requires equal-length buffers anyway. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Checks an `Authorization` header against configured `auth`. Never includes the presented or
 * expected credential in its result, so callers can put `message` straight into a response body. */
export function checkAuth(headerValue: string | undefined, auth: AuthOptions): AuthResult {
  if (auth.strategy === 'none') return { ok: true };
  if (headerValue === undefined) {
    return { ok: false, status: 401, message: 'missing Authorization header' };
  }
  if (auth.strategy === 'bearer') {
    if (!headerValue.startsWith('Bearer ')) {
      return { ok: false, status: 401, message: 'expected a Bearer token' };
    }
    const provided = headerValue.slice('Bearer '.length);
    return constantTimeEqual(provided, auth.token ?? '')
      ? { ok: true }
      : { ok: false, status: 403, message: 'invalid bearer token' };
  }
  // basic
  if (!headerValue.startsWith('Basic ')) {
    return { ok: false, status: 401, message: 'expected Basic credentials' };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(headerValue.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return { ok: false, status: 401, message: 'malformed Basic credentials' };
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return { ok: false, status: 401, message: 'malformed Basic credentials' };
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  const ok =
    constantTimeEqual(user, auth.username ?? '') && constantTimeEqual(pass, auth.password ?? '');
  return ok ? { ok: true } : { ok: false, status: 403, message: 'invalid credentials' };
}

// -------------------------------------------------------------------------------------------
// TLS
// -------------------------------------------------------------------------------------------

/** Reads the certificate/key (and optional CA) files and builds Node `tls`/`https` server options. */
export async function loadTlsServerOptions(
  options: NonNullable<TlsOptions>,
): Promise<NodeTlsOptions> {
  const [cert, key, ca] = await Promise.all([
    readFile(options.cert_file),
    readFile(options.key_file),
    options.ca_file === undefined ? Promise.resolve(undefined) : readFile(options.ca_file),
  ]);
  const tlsOptions: NodeTlsOptions = { cert, key };
  if (ca !== undefined) tlsOptions.ca = ca;
  if (options.require_client_cert) {
    tlsOptions.requestCert = true;
    tlsOptions.rejectUnauthorized = ca !== undefined;
  }
  return tlsOptions;
}

// -------------------------------------------------------------------------------------------
// Responses
// -------------------------------------------------------------------------------------------

/** A JSON error body shape that never includes request headers, credentials, or other secrets —
 * only a stable code and a human message about the (untrusted) payload or request shape. */
export interface HttpErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export function errorBody(code: string, message: string): HttpErrorBody {
  return { error: { code, message } };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, headers);
  res.end();
}

/** Rounds a millisecond wait up to whole seconds for a `Retry-After` header. */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1000));
}

// -------------------------------------------------------------------------------------------
// Misc
// -------------------------------------------------------------------------------------------

/** Reads the client's address the way the source's `remote_addr` metadata field wants it: the
 * socket peer by default, or the first `X-Forwarded-For` hop when `trustForwardedFor` is set
 * (only meaningful behind a trusted reverse proxy — never enabled by default). */
export function remoteAddress(
  req: IncomingMessage,
  trustForwardedFor: boolean,
): string | undefined {
  if (trustForwardedFor) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value !== undefined && value.trim() !== '') return value.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress;
}
