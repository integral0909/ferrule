import * as http from 'node:http';
import * as https from 'node:https';
import { brotliDecompress, gunzip, gzip, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import {
  isZstdSupported,
  zstdCompress,
  zstdDecompress,
  zstdUnsupportedMessage,
} from '@ferrule/codecs';
import { FerruleError } from '@ferrule/core';
import { SinkError, type Logger } from '@ferrule/runtime';
import type { AuthOptions, CompressionOptions, ProxyOptions, TlsOptions } from './schema.js';
import { resolveTls, type ResolvedTls } from './tls.js';
import {
  proxiedRequestTarget,
  resolveProxy,
  TunnelingHttpsAgent,
  type ResolvedProxy,
} from './proxy.js';
import { classifyHttpStatus, parseRetryAfter } from './status.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

export interface HttpClientOptions {
  readonly auth?: AuthOptions | undefined;
  readonly tls?: TlsOptions | undefined;
  readonly proxy?: ProxyOptions | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly compression?: CompressionOptions | undefined;
  /** Static headers merged into every request. Never logged. */
  readonly headers?: ReadonlyMap<string, string> | undefined;
  readonly maxSockets?: number | undefined;
  readonly logger: Logger;
}

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-cased header names, mapping to a single joined value (multi-value headers are comma-joined). */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * An HTTP(S) client shared by every sink in this package: keep-alive connection pooling, TLS
 * (with an optional CA/client-cert and a loud warning when verification is disabled), request
 * timeouts, bounded response reading, request compression, pluggable auth, and transparent
 * `HTTP(S)_PROXY`/`NO_PROXY` support (including a hand-rolled `CONNECT` tunnel for HTTPS targets
 * behind an HTTP(S) proxy). {@link request} never throws for a non-2xx response — it always
 * returns the {@link HttpResponse} so callers that need to inspect the body on failure (or a
 * mixed-outcome body like Elasticsearch's bulk API) can; use {@link ensureSuccess} to turn a
 * response into a classified {@link SinkError} the way most sinks in this family want.
 */
export class HttpClient {
  private readonly tls: ResolvedTls;
  private readonly auth: AuthOptions;
  private readonly proxyOptions: ProxyOptions | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly compression: CompressionOptions;
  private readonly staticHeaders: ReadonlyMap<string, string>;
  private readonly maxSockets: number;

  private plainHttpAgent: http.Agent | undefined;
  private plainHttpsAgent: https.Agent | undefined;
  private readonly tunnelAgents = new Map<string, TunnelingHttpsAgent>();

  constructor(options: HttpClientOptions) {
    this.tls = resolveTls(options.tls, options.logger);
    this.auth = options.auth;
    this.proxyOptions = options.proxy;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.compression = options.compression ?? 'none';
    if (this.compression === 'zstd' && !isZstdSupported()) {
      // Defensive, mirroring KafkaProducer's constructor-level check: the option schema's own
      // `.refine()` (`withZstdSupportCheck` in schema.ts) already rejects this at config
      // validation, but a caller that builds `HttpClient` directly (bypassing that schema) still
      // gets a clear error naming the required Node version instead of a cryptic failure the
      // first time a request body happens to compress.
      throw new FerruleError('E_HTTP_ZSTD_UNSUPPORTED', zstdUnsupportedMessage());
    }
    this.staticHeaders = options.headers ?? new Map();
    this.maxSockets = options.maxSockets ?? 16;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of this.staticHeaders) headers[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    applyAuth(headers, this.auth);

    let body = req.body;
    if (body !== undefined && body.byteLength > 0 && this.compression !== 'none') {
      if (this.compression === 'gzip') {
        body = await gzipAsync(body);
        headers['content-encoding'] = 'gzip';
      } else {
        body = zstdCompress(body);
        headers['content-encoding'] = 'zstd';
      }
    }
    if (body !== undefined) headers['content-length'] = String(body.byteLength);

    const proxy = resolveProxy(url, this.proxyOptions);
    const { agent, hostname, port, path, extraHeaders } = this.planRequest(url, proxy);
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] ??= v;

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(`request to ${url.hostname} timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    try {
      const raw = await performRequest({
        secure: url.protocol === 'https:',
        agent,
        hostname,
        port,
        path,
        method: req.method,
        headers,
        body,
        signal: controller.signal,
        maxResponseBytes: this.maxResponseBytes,
      });
      const decoded = await decodeBody(raw.body, raw.headers['content-encoding']);
      return { status: raw.status, headers: raw.headers, body: decoded };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Releases pooled sockets. Safe to call more than once. */
  close(): void {
    this.plainHttpAgent?.destroy();
    this.plainHttpsAgent?.destroy();
    for (const agent of this.tunnelAgents.values()) agent.destroy();
    this.tunnelAgents.clear();
  }

  private planRequest(
    url: URL,
    proxy: ResolvedProxy | undefined,
  ): {
    agent: http.Agent | https.Agent;
    hostname: string;
    port: number;
    path: string;
    extraHeaders: Record<string, string>;
  } {
    const secure = url.protocol === 'https:';
    const directPort = url.port !== '' ? Number(url.port) : secure ? 443 : 80;
    if (proxy === undefined) {
      return {
        agent: secure ? this.httpsAgent() : this.httpAgent(),
        hostname: url.hostname,
        port: directPort,
        path: url.pathname + url.search,
        extraHeaders: {},
      };
    }
    if (secure) {
      return {
        agent: this.tunnelAgent(proxy),
        hostname: url.hostname,
        port: directPort,
        path: url.pathname + url.search,
        extraHeaders: {},
      };
    }
    const target = proxiedRequestTarget(proxy);
    return {
      agent: this.httpAgent(),
      hostname: target.hostname,
      port: target.port,
      path: url.toString(),
      extraHeaders: { host: url.host },
    };
  }

  private httpAgent(): http.Agent {
    this.plainHttpAgent ??= new http.Agent({ keepAlive: true, maxSockets: this.maxSockets });
    return this.plainHttpAgent;
  }

  private httpsAgent(): https.Agent {
    this.plainHttpsAgent ??= new https.Agent({
      keepAlive: true,
      maxSockets: this.maxSockets,
      ca: this.tls.ca,
      cert: this.tls.cert,
      key: this.tls.key,
      rejectUnauthorized: this.tls.rejectUnauthorized,
      ...(this.tls.servername !== undefined ? { servername: this.tls.servername } : {}),
    });
    return this.plainHttpsAgent;
  }

  private tunnelAgent(proxy: ResolvedProxy): TunnelingHttpsAgent {
    const key = `${proxy.protocol}://${proxy.hostname}:${proxy.port}`;
    let agent = this.tunnelAgents.get(key);
    if (agent === undefined) {
      agent = new TunnelingHttpsAgent(proxy, this.tls, {
        keepAlive: true,
        maxSockets: this.maxSockets,
      });
      this.tunnelAgents.set(key, agent);
    }
    return agent;
  }
}

/** Applies an {@link AuthOptions} strategy to a (lower-cased) header map. Never logs the secret. */
export function applyAuth(headers: Record<string, string>, auth: AuthOptions): void {
  if (auth === undefined || auth.strategy === 'none') return;
  switch (auth.strategy) {
    case 'basic':
      headers['authorization'] =
        `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      return;
    case 'bearer':
      headers['authorization'] = `Bearer ${auth.token}`;
      return;
    case 'header':
      headers[auth.name.toLowerCase()] = auth.value;
      return;
  }
}

/** Turns a non-2xx {@link HttpResponse} into a classified {@link SinkError}; returns `undefined` for 2xx. */
export function ensureSuccess(response: HttpResponse, code?: string): SinkError | undefined {
  const options: { body?: string; retryAfterMs?: number; code?: string } = {};
  if (response.body.byteLength > 0) options.body = safeDecode(response.body);
  const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
  if (retryAfterMs !== undefined) options.retryAfterMs = retryAfterMs;
  if (code !== undefined) options.code = code;
  return classifyHttpStatus(response.status, options);
}

function safeDecode(bytes: Uint8Array): string {
  try {
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}

async function decodeBody(
  body: Uint8Array,
  contentEncoding: string | undefined,
): Promise<Uint8Array> {
  if (contentEncoding === undefined || contentEncoding === '' || contentEncoding === 'identity') {
    return body;
  }
  try {
    switch (contentEncoding) {
      case 'gzip':
      case 'x-gzip':
        return await gunzipAsync(body);
      case 'deflate':
        return await inflateAsync(body);
      case 'br':
        return await brotliDecompressAsync(body);
      case 'zstd':
        return zstdDecompress(body);
      default:
        return body;
    }
  } catch (cause) {
    throw new FerruleError(
      'E_HTTP_DECOMPRESS',
      `failed to decompress ${contentEncoding} response`,
      {
        cause,
      },
    );
  }
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

function performRequest(options: {
  secure: boolean;
  agent: http.Agent | https.Agent;
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  signal: AbortSignal;
  maxResponseBytes: number;
}): Promise<RawResponse> {
  const transport = options.secure ? https : http;
  return new Promise<RawResponse>((resolve, reject) => {
    const req = transport.request({
      agent: options.agent,
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: options.headers,
      signal: options.signal,
    });
    req.once('error', (err) => reject(err));
    req.once('response', (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let overflowed = false;
      res.on('data', (chunk: Buffer) => {
        if (overflowed) return;
        total += chunk.byteLength;
        if (total > options.maxResponseBytes) {
          overflowed = true;
          res.destroy();
          reject(
            SinkError.permanent(
              'E_HTTP_RESPONSE_TOO_LARGE',
              `response body exceeded ${options.maxResponseBytes} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.once('end', () => {
        if (overflowed) return;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
      res.once('error', (err) => {
        if (!overflowed) reject(err);
      });
    });
    if (options.body !== undefined && options.body.byteLength > 0) req.write(options.body);
    req.end();
  });
}
