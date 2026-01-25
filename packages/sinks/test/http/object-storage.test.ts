import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { LogEvent } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import {
  objectStorageSink,
  objectStorageSinkOptions,
} from '../../src/http/sinks/object-storage.js';
import { startServer, testBuildContext, withNotifier, type TestServer } from './helpers.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretkeysecretkeysecretkey' };

describe('object_storage sink', () => {
  it('PUTs a batch to a path-style URL, signed with SigV4', async () => {
    server = await startServer((_req, res) => res.end());
    const options = objectStorageSinkOptions.parse({
      endpoint: server.url,
      bucket: 'my-bucket',
      key: 'events',
      region: 'us-west-2',
      ...credentials,
    });
    const sink = await objectStorageSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('hi'));
    await harness.feed([event]);
    harness.close();
    await run;

    await expect(completion).resolves.toBe('delivered');
    const req = server.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toMatch(/^\/my-bucket\/events-[0-9a-f]{12}$/);

    const auth = req.headers['authorization'] as string;
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(req.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    const expectedHash = createHash('sha256').update(req.body).digest('hex');
    expect(req.headers['x-amz-content-sha256']).toBe(expectedHash);
  });

  it('renders %Y/%m/%d/%H time tokens and field references in the key, from the batch clock', async () => {
    server = await startServer((_req, res) => res.end());
    const options = objectStorageSinkOptions.parse({
      endpoint: server.url,
      bucket: 'b',
      key: '%Y/%m/%d/%H/{{ service }}/events.json',
      ...credentials,
    });
    const sink = await objectStorageSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    // Move the manual clock to a known wall-clock time before anything is sent.
    const target = Date.UTC(2024, 2, 5, 7, 8, 9);
    await harness.clock.advance(target);
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.from({ service: 'checkout', message: 'x' })]);
    harness.close();
    await run;

    expect(server.requests[0]!.url).toMatch(
      /^\/b\/2024\/03\/05\/07\/checkout\/events-[0-9a-f]{12}\.json$/,
    );
  });

  it('appends a unique suffix so consecutive batches never collide', async () => {
    server = await startServer((_req, res) => res.end());
    const options = objectStorageSinkOptions.parse({
      endpoint: server.url,
      bucket: 'b',
      key: 'events',
      batch: { maxEvents: 1 },
      ...credentials,
    });
    const sink = await objectStorageSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('a'), LogEvent.fromMessage('b')]);
    harness.close();
    await run;

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.url).not.toBe(server.requests[1]!.url);
  });

  it('uses virtual-hosted addressing when configured', async () => {
    server = await startServer((_req, res) => res.end());
    // `*.localhost` resolves to the loopback address per RFC 6761, so `my-bucket.localhost`
    // reaches the same server bound to 127.0.0.1 — used here to observe the virtual-hosted
    // `Host` header end to end without needing real DNS for an arbitrary bucket subdomain.
    const options = objectStorageSinkOptions.parse({
      endpoint: `http://localhost:${server.port}`,
      bucket: 'my-bucket',
      key: 'k',
      addressing: 'virtual',
      ...credentials,
    });
    const sink = await objectStorageSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('x')]);
    harness.close();
    await run;
    expect(server.requests[0]!.headers['host']).toBe(`my-bucket.localhost:${server.port}`);
  });

  it('gzip-compresses the object body and appends .gz to the key', async () => {
    server = await startServer((_req, res) => res.end());
    const options = objectStorageSinkOptions.parse({
      endpoint: server.url,
      bucket: 'b',
      key: 'events',
      compression: 'gzip',
      ...credentials,
    });
    const sink = await objectStorageSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('compress-me')]);
    harness.close();
    await run;

    const req = server.requests[0]!;
    expect(req.url).toContain('.gz');
    expect(req.headers['content-encoding']).toBe('gzip');
    const decompressed = gunzipSync(req.body).toString('utf8');
    expect(decompressed).toContain('compress-me');
  });

  it('includes x-amz-security-token when a session token is configured', async () => {
    server = await startServer((_req, res) => res.end());
    const options = objectStorageSinkOptions.parse({
      endpoint: server.url,
      bucket: 'b',
      key: 'k',
      sessionToken: 'the-token',
      ...credentials,
    });
    const sink = await objectStorageSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('x')]);
    harness.close();
    await run;
    expect(server.requests[0]!.headers['x-amz-security-token']).toBe('the-token');
  });
});
