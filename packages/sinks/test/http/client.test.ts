import * as net from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { SinkError, createCapturingLogger } from '@ferrule/runtime';
import { applyAuth, ensureSuccess, HttpClient } from '../../src/http/client.js';
import { resolveProxy } from '../../src/http/proxy.js';
import { parseRetryAfter } from '../../src/http/status.js';
import { startServer, type TestServer } from './helpers.js';

function logger() {
  return createCapturingLogger().logger;
}

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('HttpClient — basic request/response', () => {
  it('sends method, headers, and body, and returns the response', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'yes' });
      res.end('ok');
    });
    const client = new HttpClient({ logger: logger() });
    const response = await client.request({
      method: 'POST',
      url: `${server.url}/path?x=1`,
      headers: { 'x-test': 'abc' },
      body: new TextEncoder().encode('hello'),
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-custom']).toBe('yes');
    expect(new TextDecoder().decode(response.body)).toBe('ok');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.method).toBe('POST');
    expect(server.requests[0]!.url).toBe('/path?x=1');
    expect(server.requests[0]!.headers['x-test']).toBe('abc');
    expect(server.requests[0]!.body.toString('utf8')).toBe('hello');
    client.close();
  });
});

describe('applyAuth', () => {
  it('basic: sets a base64 Authorization header', () => {
    const headers: Record<string, string> = {};
    applyAuth(headers, { strategy: 'basic', username: 'alice', password: 'wonderland' });
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('alice:wonderland').toString('base64')}`,
    );
  });

  it('bearer: sets a Bearer Authorization header', () => {
    const headers: Record<string, string> = {};
    applyAuth(headers, { strategy: 'bearer', token: 'tok123' });
    expect(headers['authorization']).toBe('Bearer tok123');
  });

  it('header: sets an arbitrary named header', () => {
    const headers: Record<string, string> = {};
    applyAuth(headers, { strategy: 'header', name: 'X-Api-Key', value: 'secret' });
    expect(headers['x-api-key']).toBe('secret');
  });

  it('none / undefined: does nothing', () => {
    const headers: Record<string, string> = {};
    applyAuth(headers, undefined);
    applyAuth(headers, { strategy: 'none' });
    expect(headers).toEqual({});
  });
});

describe('HttpClient — auth end to end', () => {
  it('sends a basic-auth header the server can read', async () => {
    server = await startServer((_req, res) => res.end('ok'));
    const client = new HttpClient({
      logger: logger(),
      auth: { strategy: 'basic', username: 'u', password: 'p' },
    });
    await client.request({ method: 'GET', url: server.url });
    expect(server.requests[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
    client.close();
  });
});

describe('HttpClient — compression', () => {
  it('gzips the request body and sets Content-Encoding: gzip', async () => {
    server = await startServer((_req, res) => res.end('ok'));
    const client = new HttpClient({ logger: logger(), compression: 'gzip' });
    const original = new TextEncoder().encode('a'.repeat(1000));
    await client.request({ method: 'POST', url: server.url, body: original });
    const received = server.requests[0]!;
    expect(received.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(received.body)).toEqual(Buffer.from(original));
    client.close();
  });

  it('transparently decompresses a gzip response body', async () => {
    const payload = Buffer.from('decompress me please');
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync(payload));
    });
    const client = new HttpClient({ logger: logger() });
    const response = await client.request({ method: 'GET', url: server.url });
    expect(Buffer.from(response.body)).toEqual(payload);
    client.close();
  });
});

describe('HttpClient — response size limit', () => {
  it('rejects a response body larger than maxResponseBytes', async () => {
    server = await startServer((_req, res) => res.end('x'.repeat(1000)));
    const client = new HttpClient({ logger: logger(), maxResponseBytes: 10 });
    await expect(client.request({ method: 'GET', url: server.url })).rejects.toMatchObject({
      code: 'E_HTTP_RESPONSE_TOO_LARGE',
    });
    client.close();
  });
});

describe('HttpClient — timeout', () => {
  it('aborts a request that takes longer than the configured timeout', async () => {
    server = await startServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      res.end('too late');
    });
    const client = new HttpClient({ logger: logger(), timeoutMs: 30 });
    await expect(client.request({ method: 'GET', url: server.url })).rejects.toBeTruthy();
    client.close();
  }, 10_000);
});

describe('parseRetryAfter', () => {
  it('parses an integer number of seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  it('parses an HTTP-date', () => {
    const now = Date.parse('2024-01-01T00:00:00Z');
    const ms = parseRetryAfter('Mon, 01 Jan 2024 00:00:05 GMT', now);
    expect(ms).toBe(5000);
  });

  it('clamps a date in the past to zero', () => {
    const now = Date.parse('2024-01-01T00:00:10Z');
    expect(parseRetryAfter('Mon, 01 Jan 2024 00:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for absent or unparseable input', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not a date')).toBeUndefined();
  });
});

describe('ensureSuccess', () => {
  it('returns undefined for a 2xx response', () => {
    expect(ensureSuccess({ status: 200, headers: {}, body: new Uint8Array() })).toBeUndefined();
    expect(ensureSuccess({ status: 204, headers: {}, body: new Uint8Array() })).toBeUndefined();
  });

  it('classifies 429 as retryable, honouring Retry-After', () => {
    const error = ensureSuccess({
      status: 429,
      headers: { 'retry-after': '7' },
      body: new Uint8Array(),
    });
    expect(error).toBeInstanceOf(SinkError);
    expect(error?.retryable).toBe(true);
    expect(error?.retryAfterMs).toBe(7000);
  });

  it('classifies 500 as retryable and 404 as permanent', () => {
    expect(ensureSuccess({ status: 500, headers: {}, body: new Uint8Array() })?.retryable).toBe(
      true,
    );
    expect(ensureSuccess({ status: 404, headers: {}, body: new Uint8Array() })?.retryable).toBe(
      false,
    );
  });

  it('includes a truncated response body in the message', () => {
    const body = new TextEncoder().encode('bad request: missing field "x"');
    const error = ensureSuccess({ status: 400, headers: {}, body });
    expect(error?.message).toContain('missing field');
  });
});

describe('resolveProxy', () => {
  it('returns undefined with no proxy env set', () => {
    expect(resolveProxy(new URL('http://example.com'), undefined, {})).toBeUndefined();
  });

  it('picks HTTP_PROXY for an http:// target and HTTPS_PROXY for an https:// target', () => {
    const env = { HTTP_PROXY: 'http://proxy1:8080', HTTPS_PROXY: 'http://proxy2:8081' };
    expect(resolveProxy(new URL('http://example.com'), undefined, env)).toMatchObject({
      hostname: 'proxy1',
      port: 8080,
    });
    expect(resolveProxy(new URL('https://example.com'), undefined, env)).toMatchObject({
      hostname: 'proxy2',
      port: 8081,
    });
  });

  it('honours NO_PROXY exact and suffix matches', () => {
    const env = { HTTP_PROXY: 'http://proxy:8080', NO_PROXY: 'example.com,.internal' };
    expect(resolveProxy(new URL('http://example.com'), undefined, env)).toBeUndefined();
    expect(resolveProxy(new URL('http://svc.internal'), undefined, env)).toBeUndefined();
    expect(resolveProxy(new URL('http://other.com'), undefined, env)).toBeDefined();
  });

  it('NO_PROXY "*" disables proxying entirely', () => {
    const env = { HTTP_PROXY: 'http://proxy:8080', NO_PROXY: '*' };
    expect(resolveProxy(new URL('http://example.com'), undefined, env)).toBeUndefined();
  });

  it('an explicit options.url overrides the environment', () => {
    const env = { HTTP_PROXY: 'http://from-env:8080' };
    const resolved = resolveProxy(
      new URL('http://example.com'),
      { use_env: true, url: 'http://explicit:9' },
      env,
    );
    expect(resolved).toMatchObject({ hostname: 'explicit', port: 9 });
  });

  it('use_env: false ignores the environment entirely', () => {
    const env = { HTTP_PROXY: 'http://from-env:8080' };
    expect(resolveProxy(new URL('http://example.com'), { use_env: false }, env)).toBeUndefined();
  });

  it('extracts basic-auth credentials embedded in the proxy URL', () => {
    const resolved = resolveProxy(
      new URL('http://x.com'),
      { use_env: true, url: 'http://user:pass@proxy:8080' },
      {},
    );
    expect(resolved?.auth).toEqual({ username: 'user', password: 'pass' });
  });
});

describe('HttpClient — plain HTTP target through a forward proxy', () => {
  it('addresses the request to the proxy with an absolute-form URI and the origin Host header', async () => {
    server = await startServer((_req, res) => res.end('via-proxy'));
    const client = new HttpClient({
      logger: logger(),
      proxy: { use_env: false, url: server.url },
    });
    const response = await client.request({
      method: 'GET',
      url: 'http://origin.example.com/thing',
    });
    expect(new TextDecoder().decode(response.body)).toBe('via-proxy');
    const received = server.requests[0]!;
    expect(received.url).toBe('http://origin.example.com/thing');
    expect(received.headers['host']).toBe('origin.example.com');
    client.close();
  });
});

describe('HttpClient — HTTPS target through a proxy (CONNECT tunnel failure path)', () => {
  it('surfaces an error when the proxy refuses the CONNECT', async () => {
    const proxy = net.createServer((socket) => {
      socket.on('data', () => {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    const address = proxy.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const client = new HttpClient({
      logger: logger(),
      proxy: { use_env: false, url: `http://127.0.0.1:${port}` },
      timeoutMs: 2_000,
    });
    await expect(
      client.request({ method: 'GET', url: 'https://example.com/secure' }),
    ).rejects.toBeTruthy();
    client.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
});
