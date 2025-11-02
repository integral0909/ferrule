import { request as httpRequest, type IncomingMessage } from 'node:http';
import { parseJson, type Value } from '@ferrule/core';
import type { PipelineHealth, ReloadResult, TopologySnapshot } from '@ferrule/runtime';
import type { ComponentDetail, MetricEventJson } from './types.js';

export interface AdminClientOptions {
  /** e.g. `http://127.0.0.1:9090`. */
  readonly baseUrl: string;
  readonly token?: string;
  /** Per-request timeout. Does not apply to `tap`, which is a long-lived stream. Default 30000. */
  readonly timeoutMs?: number;
}

export interface ClientTapOptions {
  readonly port?: string;
  /** Sampling rate in (0, 1]. */
  readonly sample?: number;
  readonly limit?: number;
}

/** Raised for any non-2xx admin API response. Carries the server's error code when the body was
 * a well-formed error envelope. */
export class AdminClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function readAll(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function errorFromBody(status: number, body: string): AdminClientError {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    if (parsed.error !== undefined) {
      return new AdminClientError(
        status,
        parsed.error.code ?? 'E_UNKNOWN',
        parsed.error.message ?? body,
      );
    }
  } catch {
    // Not a JSON error envelope; fall through to a generic error below.
  }
  return new AdminClientError(
    status,
    'E_UNKNOWN',
    body.length > 0 ? body : `request failed with status ${status}`,
  );
}

/**
 * A small typed client for the admin API, built directly on `node:http` (not `fetch`) so that
 * streaming `/tap` responses are read incrementally without depending on the Web Streams / Node
 * interop for the platform's global `fetch`. Used by `ferrule tap`, `ferrule status`, and similar
 * CLI commands.
 */
export class AdminClient {
  private readonly baseUrl: URL;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: AdminClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<PipelineHealth> {
    return this.getJson<PipelineHealth>('/health');
  }

  async live(): Promise<{ status: string }> {
    return this.getJson('/health/live');
  }

  async ready(): Promise<{ status: string; overall: string }> {
    return this.getJson('/health/ready');
  }

  async topology(): Promise<TopologySnapshot> {
    return this.getJson<TopologySnapshot>('/topology');
  }

  async topologyDot(): Promise<string> {
    return this.getText('/topology', { format: 'dot' });
  }

  async topologyMermaid(): Promise<string> {
    return this.getText('/topology', { format: 'mermaid' });
  }

  async metrics(): Promise<readonly MetricEventJson[]> {
    return this.getJson<MetricEventJson[]>('/metrics', { format: 'json' });
  }

  async metricsText(): Promise<string> {
    return this.getText('/metrics', { format: 'text' });
  }

  async component(id: string): Promise<ComponentDetail> {
    return this.getJson<ComponentDetail>(`/components/${encodeURIComponent(id)}`);
  }

  /** The redacted effective configuration, as text. */
  async config(): Promise<string> {
    return this.getText('/config');
  }

  async reload(): Promise<ReloadResult> {
    const { status, body } = await this.send('POST', '/reload');
    if (status !== 200 && status !== 422) throw errorFromBody(status, body);
    return JSON.parse(body) as ReloadResult;
  }

  /**
   * Streams tap events as they arrive, decoded with the lossless core JSON codec (so integers,
   * bytes, and timestamps come back as the right `Value` kind, not generic `JSON.parse` output).
   * Breaking out of the `for await` loop (or letting it end, e.g. via `options.limit`) closes the
   * underlying connection, which ends the server's subscription too.
   */
  async *tap(component: string, options: ClientTapOptions = {}): AsyncGenerator<Value, void, void> {
    const query: Record<string, string> = { format: 'ndjson' };
    if (options.port !== undefined) query['port'] = options.port;
    if (options.sample !== undefined) query['sample'] = String(options.sample);
    if (options.limit !== undefined) query['limit'] = String(options.limit);

    const res = await this.open('GET', `/tap/${encodeURIComponent(component)}`, query, 0);
    if (res.statusCode !== 200) {
      const body = await readAll(res);
      throw errorFromBody(res.statusCode ?? 500, body);
    }
    let buffer = '';
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) yield parseJson(line);
          newline = buffer.indexOf('\n');
        }
      }
    } finally {
      res.destroy();
    }
  }

  private async getJson<T>(path: string, query?: Record<string, string>): Promise<T> {
    const { status, body } = await this.send('GET', path, query);
    if (status !== 200) throw errorFromBody(status, body);
    return JSON.parse(body) as T;
  }

  private async getText(path: string, query?: Record<string, string>): Promise<string> {
    const { status, body } = await this.send('GET', path, query);
    if (status !== 200) throw errorFromBody(status, body);
    return body;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const res = await this.open(method, path, query, this.timeoutMs);
    const body = await readAll(res);
    return { status: res.statusCode ?? 0, body };
  }

  private open(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> | undefined,
    timeoutMs: number,
  ): Promise<IncomingMessage> {
    const url = new URL(path, this.baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {};
    if (this.token !== undefined) headers['Authorization'] = `Bearer ${this.token}`;
    const requestOptions = { method, headers, ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) };
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, requestOptions, resolve);
      req.on('error', reject);
      req.on('timeout', () =>
        req.destroy(new Error(`admin request timed out after ${timeoutMs}ms`)),
      );
      req.end();
    });
  }
}
