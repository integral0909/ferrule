import { afterEach, describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { elasticsearchSink, elasticsearchSinkOptions } from '../../src/http/sinks/elasticsearch.js';
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

function parseBulkLines(body: Buffer): unknown[] {
  return body
    .toString('utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l): unknown => JSON.parse(l));
}

describe('elasticsearch sink', () => {
  it('sends one action line + one document line per event, defaulting to the "index" action', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          errors: false,
          items: [{ index: { status: 201 } }, { index: { status: 201 } }],
        }),
      );
    });
    const options = elasticsearchSinkOptions.parse({ url: server.url, index: 'logs' });
    const sink = await elasticsearchSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const a = withNotifier(LogEvent.from({ message: 'one' }));
    const b = withNotifier(LogEvent.from({ message: 'two' }));
    await harness.feed([a.event, b.event]);
    harness.close();
    await run;

    await expect(a.completion).resolves.toBe('delivered');
    await expect(b.completion).resolves.toBe('delivered');
    const req = server.requests[0]!;
    expect(req.url).toBe('/_bulk');
    expect(req.headers['content-type']).toBe('application/x-ndjson');
    const lines = parseBulkLines(req.body);
    expect(lines).toEqual([
      { index: { _index: 'logs' } },
      { message: 'one' },
      { index: { _index: 'logs' } },
      { message: 'two' },
    ]);
  });

  it('templates the index name with a date token and a field reference', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ errors: false, items: [{ index: { status: 200 } }] }));
    });
    const options = elasticsearchSinkOptions.parse({
      url: server.url,
      index: 'logs-%Y.%m.%d-{{ service }}',
    });
    const sink = await elasticsearchSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    await harness.clock.advance(Date.UTC(2024, 5, 1));
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.from({ message: 'x', service: 'api' })]);
    harness.close();
    await run;

    const [action] = parseBulkLines(server.requests[0]!.body) as [{ index: { _index: string } }];
    expect(action.index._index).toBe('logs-2024.06.01-api');
  });

  it('sets _id from the configured id_field', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ errors: false, items: [{ index: { status: 200 } }] }));
    });
    const options = elasticsearchSinkOptions.parse({
      url: server.url,
      index: 'logs',
      id_field: '.id',
    });
    const sink = await elasticsearchSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.from({ id: 'abc-123', message: 'x' })]);
    harness.close();
    await run;
    const [action] = parseBulkLines(server.requests[0]!.body) as [{ index: { _id: string } }];
    expect(action.index._id).toBe('abc-123');
  });

  it('forces the "create" action in data-stream mode', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ errors: false, items: [{ create: { status: 201 } }] }));
    });
    const options = elasticsearchSinkOptions.parse({
      url: server.url,
      index: 'logs-ds',
      data_stream: true,
    });
    const sink = await elasticsearchSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('x')]);
    harness.close();
    await run;
    const [action] = parseBulkLines(server.requests[0]!.body) as [Record<string, unknown>];
    expect(Object.keys(action)).toEqual(['create']);
  });

  it('resolves each event to its own delivery status from the bulk response items', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          errors: true,
          items: [
            { index: { status: 201 } },
            { index: { status: 400, error: { type: 'mapper_parsing_exception' } } },
            { index: { status: 429 } },
            { index: { status: 503 } },
          ],
        }),
      );
    });
    const options = elasticsearchSinkOptions.parse({ url: server.url, index: 'logs' });
    const sink = await elasticsearchSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const ok = withNotifier(LogEvent.fromMessage('ok'));
    const bad = withNotifier(LogEvent.fromMessage('bad'));
    const throttled = withNotifier(LogEvent.fromMessage('throttled'));
    const unavailable = withNotifier(LogEvent.fromMessage('unavailable'));
    await harness.feed([ok.event, bad.event, throttled.event, unavailable.event]);
    harness.close();
    await run;

    await expect(ok.completion).resolves.toBe('delivered');
    await expect(bad.completion).resolves.toBe('rejected');
    await expect(throttled.completion).resolves.toBe('errored');
    await expect(unavailable.completion).resolves.toBe('errored');
  });

  it('treats a whole-request failure as a normal batch-level retryable error', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const options = elasticsearchSinkOptions.parse({
      url: server.url,
      index: 'logs',
      retry: { max_attempts: 1 },
    });
    const sink = await elasticsearchSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('x'));
    await harness.feed([event]);
    harness.close();
    await drainRetries(harness.clock, run);
    await expect(completion).resolves.toBe('errored');
  });
});
