import { afterEach, describe, expect, it } from 'vitest';
import { LogEvent, MetricEvent } from '@ferrule/core';
import { decodeExportLogsServiceRequest, decodeOtlpJsonLogs, ProtoWriter } from '@ferrule/codecs';
import { createTestSinkContext } from '@ferrule/runtime';
import { otlpSink, otlpSinkOptions } from '../../src/http/sinks/otlp.js';
import { startServer, testBuildContext, withNotifier, type TestServer } from './helpers.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function partialSuccessProtobuf(rejected: bigint, message: string): Uint8Array {
  const writer = new ProtoWriter();
  writer.writeMessage(1, (inner) => {
    inner.writeInt64(1, rejected);
    inner.writeString(2, message);
  });
  return writer.finish();
}

describe('otlp sink', () => {
  it('POSTs an OTLP/protobuf logs export request to /v1/logs, round-trippable by the codec', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const options = otlpSinkOptions.parse({
      endpoint: server.url,
      signal: 'logs',
      protocol: 'protobuf',
    });
    const sink = await otlpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.from({ message: 'hi' }));
    await harness.feed([event]);
    harness.close();
    await run;

    await expect(completion).resolves.toBe('delivered');
    const req = server.requests[0]!;
    expect(req.url).toBe('/v1/logs');
    expect(req.headers['content-type']).toBe('application/x-protobuf');
    const decoded = decodeExportLogsServiceRequest(req.body);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.get('message')).toBe('hi');
  });

  it('supports the OTLP/JSON protocol', async () => {
    server = await startServer((_req, res) => res.end());
    const options = otlpSinkOptions.parse({
      endpoint: server.url,
      signal: 'logs',
      protocol: 'json',
    });
    const sink = await otlpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.from({ message: 'json-mode' })]);
    harness.close();
    await run;

    const req = server.requests[0]!;
    expect(req.headers['content-type']).toBe('application/json');
    const decoded = decodeOtlpJsonLogs(req.body.toString('utf8'));
    expect(decoded[0]!.get('message')).toBe('json-mode');
  });

  it('uses the metrics/traces paths and default port for those signals', async () => {
    server = await startServer((_req, res) => res.end());
    const options = otlpSinkOptions.parse({ endpoint: server.url, signal: 'metrics' });
    const sink = await otlpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([
      new MetricEvent({ name: 'requests', kind: 'absolute', value: { type: 'counter', value: 5 } }),
    ]);
    harness.close();
    await run;
    expect(server.requests[0]!.url).toBe('/v1/metrics');
  });

  it('treats a 2xx response with partial_success as delivered, logging a warning', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(Buffer.from(partialSuccessProtobuf(3n, 'dropped 3 records')));
    });
    const options = otlpSinkOptions.parse({ endpoint: server.url, signal: 'logs' });
    const buildCtx = testBuildContext();
    const sink = await otlpSink.build(options, buildCtx.ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('x'));
    await harness.feed([event]);
    harness.close();
    await run;

    await expect(completion).resolves.toBe('delivered');
    const warning = buildCtx.logs.find((l) => l.level === 'warn');
    expect(warning?.fields['rejected']).toBe('3');
  });

  it('rejects an event of the wrong kind for the configured signal without making a request', async () => {
    server = await startServer((_req, res) => res.end());
    const options = otlpSinkOptions.parse({ endpoint: server.url, signal: 'logs' });
    const sink = await otlpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(
      new MetricEvent({ name: 'm', kind: 'absolute', value: { type: 'gauge', value: 1 } }),
    );
    await harness.feed([event]);
    harness.close();
    await run;
    await expect(completion).resolves.toBe('rejected');
    expect(server.requests).toHaveLength(0);
  });

  it('classifies a non-2xx response as a batch failure', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    const options = otlpSinkOptions.parse({ endpoint: server.url, signal: 'logs' });
    const sink = await otlpSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.fromMessage('bad'));
    await harness.feed([event]);
    harness.close();
    await run;
    await expect(completion).resolves.toBe('rejected');
  });
});
