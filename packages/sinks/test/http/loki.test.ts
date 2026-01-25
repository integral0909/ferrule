import { afterEach, describe, expect, it } from 'vitest';
import { LogEvent, Timestamp } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { lokiSink, lokiSinkOptions } from '../../src/http/sinks/loki.js';
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

function logAt(fields: Record<string, unknown>, ts: Timestamp): LogEvent {
  const event = LogEvent.from(fields);
  event.set('timestamp', ts);
  return event;
}

describe('loki sink', () => {
  it('pushes one stream with templated labels and the message as the line', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const options = lokiSinkOptions.parse({
      url: server.url,
      labels: { job: 'myapp', level: '{{ level }}' },
      tenant: 'team-a',
    });
    const sink = await lokiSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.from({ message: 'hello', level: 'info' }));
    await harness.feed([event]);
    harness.close();
    await run;

    await expect(completion).resolves.toBe('delivered');
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.url).toBe('/loki/api/v1/push');
    expect(req.headers['x-scope-orgid']).toBe('team-a');
    const body = JSON.parse(req.body.toString('utf8')) as {
      streams: { stream: Record<string, string>; values: [string, string][] }[];
    };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]!.stream).toEqual({ job: 'myapp', level: 'info' });
    expect(body.streams[0]!.values).toEqual([[expect.any(String), 'hello']]);
  });

  it('partitions events into separate streams by their resolved label set', async () => {
    server = await startServer((_req, res) => res.end());
    const options = lokiSinkOptions.parse({ url: server.url, labels: { level: '{{ level }}' } });
    const sink = await lokiSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([
      LogEvent.from({ message: 'a', level: 'info' }),
      LogEvent.from({ message: 'b', level: 'error' }),
      LogEvent.from({ message: 'c', level: 'info' }),
    ]);
    harness.close();
    await run;

    expect(server.requests).toHaveLength(2);
    const byLevel = new Map(
      server.requests.map((r) => {
        const body = JSON.parse(r.body.toString('utf8')) as {
          streams: { stream: { level: string } }[];
        };
        return [body.streams[0]!.stream.level, r];
      }),
    );
    expect([...byLevel.keys()].sort()).toEqual(['error', 'info']);
  });

  it('sorts entries within a stream ascending by timestamp when outOfOrder is "sort"', async () => {
    server = await startServer((_req, res) => res.end());
    const options = lokiSinkOptions.parse({
      url: server.url,
      labels: { job: 'x' },
      timestampField: '.timestamp',
    });
    const sink = await lokiSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const late = logAt({ message: 'late' }, Timestamp.fromMillis(2000));
    const early = logAt({ message: 'early' }, Timestamp.fromMillis(1000));
    await harness.feed([late, early]);
    harness.close();
    await run;

    const body = JSON.parse(server.requests[0]!.body.toString('utf8')) as {
      streams: { values: [string, string][] }[];
    };
    expect(body.streams[0]!.values.map(([, line]) => line)).toEqual(['early', 'late']);
  });

  it('rejects events for a new stream once maxStreams is reached, without touching existing streams', async () => {
    server = await startServer((_req, res) => res.end());
    const options = lokiSinkOptions.parse({
      url: server.url,
      labels: { level: '{{ level }}' },
      maxStreams: 1,
    });
    const sink = await lokiSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const first = withNotifier(LogEvent.from({ message: 'a', level: 'info' }));
    const overflow = withNotifier(LogEvent.from({ message: 'b', level: 'warn' }));
    await harness.feed([first.event, overflow.event]);
    harness.close();
    await run;

    await expect(first.completion).resolves.toBe('delivered');
    await expect(overflow.completion).resolves.toBe('rejected');
    expect(server.requests).toHaveLength(1);
  });

  it('rejects the whole batch as errored when the endpoint keeps failing', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const options = lokiSinkOptions.parse({
      url: server.url,
      labels: { job: 'x' },
      retry: { maxAttempts: 1 },
    });
    const sink = await lokiSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('x'));
    await harness.feed([event]);
    harness.close();
    await drainRetries(harness.clock, run);
    await expect(completion).resolves.toBe('errored');
  });
});
