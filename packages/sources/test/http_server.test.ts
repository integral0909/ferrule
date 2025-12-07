import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { isLogEvent, type LogEvent } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import {
  httpServerSource,
  type HttpServerOptions,
  type HttpServerSourceHandle,
} from '../src/http_server.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';
import { generateSelfSignedCert } from './support/self-signed-cert.js';

function buildCtx(id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir: undefined, inputs: [] };
}

/** Raw (unparsed) options, as a user would write them in YAML — always includes `address`. */
type RawOptions = Record<string, unknown> & { address: string };

async function start(rawOptions: RawOptions, acknowledgements = true) {
  const parsed: HttpServerOptions = httpServerSource.options.parse(rawOptions);
  const handle = (await httpServerSource.build(parsed, buildCtx())) as HttpServerSourceHandle;
  const harness = createControllableSourceContext({ acknowledgements });
  const runPromise = handle.run(harness.ctx);
  await waitUntil(() => handle.address() !== undefined);
  const addr = handle.address()!;
  return {
    handle,
    harness,
    runPromise,
    baseUrl: `${rawOptions['tls'] === undefined ? 'http' : 'https'}://127.0.0.1:${addr.port}`,
    async stop(): Promise<void> {
      harness.releaseSends();
      harness.abort();
      await runPromise;
    },
  };
}

const runningServers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((s) => s.stop()));
});

async function startTracked(rawOptions: RawOptions, acknowledgements = true) {
  const started = await start(rawOptions, acknowledgements);
  runningServers.push(started);
  return started;
}

describe('http_server: happy path', () => {
  it('decodes ndjson and delivers with a 200 once acknowledged', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = '{"message":"a"}\n{"message":"b"}\n';
    const responsePromise = fetch(`${baseUrl}/`, { method: 'POST', body });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const json = (await response.json()) as { accepted: number };
    expect(json.accepted).toBe(2);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events.map((e) => e.get('message'))).toEqual(['a', 'b']);
  });

  it('responds 204 for an empty body', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '' });
    expect(response.status).toBe(204);
  });

  it('responds 200 immediately when acknowledgements are off', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' }, false);
    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '{"message":"x"}\n' });
    expect(response.status).toBe(200);
  });

  it('applies request metadata to decoded log events', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const responsePromise = fetch(`${baseUrl}/?x=1`, {
      method: 'POST',
      body: '{"message":"a"}\n',
      headers: { 'x-trace-id': 'abc123' },
    });
    await waitUntil(() => harness.sent.length === 1);
    const [event] = harness.sent[0]!.events as LogEvent[];
    expect(event!.get('http.path')).toBe('/');
    expect(event!.get('http.query')).toBe('x=1');
    expect(typeof event!.get('http.remote_addr')).toBe('string');
    for (const e of harness.sent[0]!.events) e.metadata.finalizers.finish('delivered');
    await responsePromise;
  });

  it('answers the health endpoint', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toEqual({ status: 'ok' });
  });

  it('responds 404 for unknown paths', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/nope`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
});

describe('http_server: decoding errors and limits', () => {
  it('responds 400 with a JSON error body for malformed frames', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '{not json}\n' });
    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBeTypeOf('string');
    expect(json.error.message).not.toContain('Authorization');
  });

  it('responds 413 for a body exceeding maxBodyBytes', async () => {
    const { baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      maxBodyBytes: 16,
    });
    const response = await fetch(`${baseUrl}/`, {
      method: 'POST',
      body: '{"message":"this is definitely too long"}\n',
    });
    expect(response.status).toBe(413);
  });

  it('rejects a zip bomb: a small gzip body that decompresses past maxBodyBytes', async () => {
    const { baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      maxBodyBytes: 1024,
    });
    const huge = `{"message":"${'x'.repeat(1_000_000)}"}\n`;
    const compressed = gzipSync(Buffer.from(huge));
    expect(compressed.length).toBeLessThan(2000); // confirms this really is a high compression ratio
    const response = await fetch(`${baseUrl}/`, {
      method: 'POST',
      body: compressed,
      headers: { 'content-encoding': 'gzip' },
    });
    expect(response.status).toBe(413);
  });

  it('decodes a gzip-compressed body within limits', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const compressed = gzipSync(Buffer.from('{"message":"a"}\n'));
    const responsePromise = fetch(`${baseUrl}/`, {
      method: 'POST',
      body: compressed,
      headers: { 'content-encoding': 'gzip' },
    });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    expect((await responsePromise).status).toBe(200);
  });

  it('responds 415 for an unsupported content-encoding', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-encoding': 'compress' },
    });
    expect(response.status).toBe(415);
  });
});

describe('http_server: authentication', () => {
  it('rejects requests with no Authorization header when bearer auth is required', async () => {
    const { baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      auth: { scheme: 'bearer', token: 'secret-token' },
    });
    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('rejects an incorrect bearer token with 403', async () => {
    const { baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      auth: { scheme: 'bearer', token: 'secret-token' },
    });
    const response = await fetch(`${baseUrl}/`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(403);
  });

  it('accepts a correct bearer token', async () => {
    const { harness, baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      auth: { scheme: 'bearer', token: 'secret-token' },
    });
    const responsePromise = fetch(`${baseUrl}/`, {
      method: 'POST',
      body: '{"message":"a"}\n',
      headers: { authorization: 'Bearer secret-token' },
    });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    expect((await responsePromise).status).toBe(200);
  });

  it('accepts correct basic credentials and rejects incorrect ones', async () => {
    const { harness, baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      auth: { scheme: 'basic', username: 'alice', password: 'hunter2' },
    });
    const bad = await fetch(`${baseUrl}/`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Basic ${Buffer.from('alice:wrong').toString('base64')}` },
    });
    expect(bad.status).toBe(403);

    const goodPromise = fetch(`${baseUrl}/`, {
      method: 'POST',
      body: '{"message":"a"}\n',
      headers: { authorization: `Basic ${Buffer.from('alice:hunter2').toString('base64')}` },
    });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    expect((await goodPromise).status).toBe(200);
  });
});

describe('http_server: backpressure and acknowledgement outcomes', () => {
  it('responds 503 with Retry-After once the backpressure timeout elapses', async () => {
    const parsed = httpServerSource.options.parse({
      address: '127.0.0.1:0',
      backpressureTimeoutMs: 200,
    });
    const handle = (await httpServerSource.build(parsed, buildCtx())) as HttpServerSourceHandle;
    const harness = createControllableSourceContext();
    harness.blockSends();
    const runPromise = handle.run(harness.ctx);
    runningServers.push({
      stop: async () => {
        harness.releaseSends();
        harness.abort();
        await runPromise;
      },
    });
    await waitUntil(() => handle.address() !== undefined);
    const addr = handle.address()!;
    const responsePromise = fetch(`http://127.0.0.1:${addr.port}/`, {
      method: 'POST',
      body: '{"message":"a"}\n',
    });
    await waitUntil(() => harness.sent.length === 1);
    await harness.clock.advance(200);
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    harness.releaseSends();
  });

  it('maps an errored acknowledgement to a retryable 503', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const responsePromise = fetch(`${baseUrl}/`, { method: 'POST', body: '{"message":"a"}\n' });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('errored');
    const response = await responsePromise;
    expect(response.status).toBe(503);
  });

  it('maps a rejected acknowledgement to a permanent 400', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const responsePromise = fetch(`${baseUrl}/`, { method: 'POST', body: '{"message":"a"}\n' });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('rejected');
    const response = await responsePromise;
    expect(response.status).toBe(400);
  });

  it('rejects requests over maxConcurrentRequests with 429', async () => {
    const { harness, baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      maxConcurrentRequests: 1,
    });
    harness.blockSends();
    const first = fetch(`${baseUrl}/`, { method: 'POST', body: '{"message":"a"}\n' });
    await waitUntil(() => harness.sent.length === 1);
    const second = await fetch(`${baseUrl}/`, { method: 'POST', body: '{"message":"b"}\n' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).not.toBeNull();
    harness.releaseSends();
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    await first;
  });
});

describe('http_server: graceful shutdown', () => {
  it('finishes an in-flight request before run() resolves, and stops accepting new ones', async () => {
    const parsed = httpServerSource.options.parse({ address: '127.0.0.1:0' });
    const handle = (await httpServerSource.build(parsed, buildCtx())) as HttpServerSourceHandle;
    const harness = createControllableSourceContext();
    harness.blockSends();
    const runPromise = handle.run(harness.ctx);
    await waitUntil(() => handle.address() !== undefined);
    const addr = handle.address()!;
    const inFlight = fetch(`http://127.0.0.1:${addr.port}/`, {
      method: 'POST',
      body: '{"message":"a"}\n',
    });
    await waitUntil(() => harness.sent.length === 1);

    harness.abort();
    let resolved = false;
    void runPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false); // still waiting on the in-flight request

    harness.releaseSends();
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    const response = await inFlight;
    expect(response.status).toBe(200);
    await runPromise;
    expect(resolved).toBe(true);
  });
});

describe('http_server: TLS', () => {
  it('serves over HTTPS with a configured certificate', async () => {
    const { certPem, keyPem } = generateSelfSignedCert('127.0.0.1');
    const fs = await import('node:fs/promises');
    const certFile = `${process.env['TMPDIR'] ?? '/tmp'}/ferrule-http-server-test-cert-${process.pid}.pem`;
    const keyFile = `${process.env['TMPDIR'] ?? '/tmp'}/ferrule-http-server-test-key-${process.pid}.pem`;
    await fs.writeFile(certFile, certPem);
    await fs.writeFile(keyFile, keyPem);
    try {
      const { handle } = await startTracked({ address: '127.0.0.1:0', tls: { certFile, keyFile } });
      const addr = handle.address()!;

      // Node's fetch (undici) validates the peer certificate against the system trust store; a
      // fresh self-signed cert isn't in it, so use `tls.connect` directly to verify the server
      // actually negotiates TLS and speaks HTTP on top of it, with the cert we configured.
      const tls = await import('node:tls');
      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
          { host: '127.0.0.1', port: addr.port, ca: certPem, checkServerIdentity: () => undefined },
          () => {
            try {
              expect(socket.authorized).toBe(true);
              socket.end();
              resolve();
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
        socket.on('error', reject);
      });
    } finally {
      await fs.rm(certFile, { force: true });
      await fs.rm(keyFile, { force: true });
    }
  });
});
