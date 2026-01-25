import { afterEach, describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { httpSink, httpSinkOptions } from '../../src/http/sinks/http.js';
import {
  drainRetries,
  startServer,
  testBuildContext,
  withNotifier,
  type TestServer,
} from './helpers.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('http sink', () => {
  it('POSTs a batch as ndjson by default, with the message field templated into the URL', async () => {
    server = await startServer((_req, res) => res.end());
    const options = httpSinkOptions.parse({ url: `${server.url}/ingest/{{ service }}` });
    const sink = await httpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();

    const run = sink.run(harness.ctx);
    const a = withNotifier(LogEvent.from({ service: 'api', message: 'one' }));
    const b = withNotifier(LogEvent.from({ service: 'api', message: 'two' }));
    await harness.feed([a.event, b.event]);
    harness.close();
    await run;

    await expect(a.completion).resolves.toBe('delivered');
    await expect(b.completion).resolves.toBe('delivered');
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/ingest/api');
    expect(request.headers['content-type']).toBe('application/x-ndjson');
    const lines = request.body.toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: 'one' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ message: 'two' });
  });

  it('supports json_array framing', async () => {
    server = await startServer((_req, res) => res.end());
    const options = httpSinkOptions.parse({
      url: server.url,
      framing: 'json_array',
      codec: 'json',
    });
    const sink = await httpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('a'), LogEvent.fromMessage('b')]);
    harness.close();
    await run;
    const parsed = JSON.parse(server.requests[0]!.body.toString('utf8')) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('retries a 500 and eventually delivers', async () => {
    let calls = 0;
    server = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
    const options = httpSinkOptions.parse({ url: server.url });
    const sink = await httpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('retry-me'));
    await harness.feed([event]);
    harness.close();
    await drainRetries(harness.clock, run);
    expect(calls).toBe(2);
    await expect(completion).resolves.toBe('delivered');
  });

  it('does not retry a 400 and rejects the event immediately', async () => {
    let calls = 0;
    server = await startServer((_req, res) => {
      calls++;
      res.writeHead(400);
      res.end('bad');
    });
    const options = httpSinkOptions.parse({ url: server.url });
    const sink = await httpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('bad-event'));
    await harness.feed([event]);
    harness.close();
    await drainRetries(harness.clock, run);
    expect(calls).toBe(1);
    await expect(completion).resolves.toBe('rejected');
  });

  it('exhausts retries and reports errored', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const options = httpSinkOptions.parse({
      url: server.url,
      retry: { maxAttempts: 2, initialDelay: 1, maxDelay: 5 },
    });
    const sink = await httpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('x'));
    await harness.feed([event]);
    harness.close();
    await drainRetries(harness.clock, run);
    await expect(completion).resolves.toBe('errored');
  });

  it('sends configured static headers and auth', async () => {
    server = await startServer((_req, res) => res.end());
    const options = httpSinkOptions.parse({
      url: server.url,
      headers: { 'x-team': 'observability' },
      auth: { type: 'bearer', token: 'shh' },
    });
    const sink = await httpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('hi')]);
    harness.close();
    await run;
    const req = server.requests[0]!;
    expect(req.headers['x-team']).toBe('observability');
    expect(req.headers['authorization']).toBe('Bearer shh');
  });
});
