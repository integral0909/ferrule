import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
} from '@ferrule/core';
import {
  encodeExportLogsServiceRequest,
  encodeExportMetricsServiceRequest,
  encodeExportTraceServiceRequest,
  encodeOtlpJsonLogs,
  encodeOtlpJsonMetrics,
  encodeOtlpJsonTraces,
  forEachField,
} from '@ferrule/codecs';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { otlpSource, type OtlpOptions, type OtlpSourceHandle } from '../src/otlp.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';

function buildCtx(id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir: undefined, inputs: [] };
}

/** Raw (unparsed) options, as a user would write them in YAML — always includes `address`. */
type RawOptions = Record<string, unknown> & { address: string };

async function start(rawOptions: RawOptions, acknowledgements = true) {
  const parsed: OtlpOptions = otlpSource.options.parse(rawOptions);
  const handle = (await otlpSource.build(parsed, buildCtx())) as OtlpSourceHandle;
  const harness = createControllableSourceContext({ acknowledgements });
  const runPromise = handle.run(harness.ctx);
  await waitUntil(() => handle.address() !== undefined);
  const addr = handle.address()!;
  return {
    handle,
    harness,
    runPromise,
    baseUrl: `http://127.0.0.1:${addr.port}`,
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

// --- test fixtures --------------------------------------------------------------------------

function sampleLogEvent(): LogEvent {
  return LogEvent.fromMessage('hello from otlp');
}

function sampleMetricEvent(): MetricEvent {
  return new MetricEvent({
    name: 'requests_total',
    kind: 'absolute',
    value: { type: 'gauge', value: 42 },
  });
}

function sampleSpanEvent(): SpanEvent {
  return new SpanEvent({
    traceId: new Uint8Array(16).fill(1),
    spanId: new Uint8Array(8).fill(2),
    name: 'do-work',
    startTime: Timestamp.fromMillis(1_000),
    endTime: Timestamp.fromMillis(2_000),
  });
}

/** Decodes a `google.rpc.Status`-shaped protobuf error body (field 1 = int32 code, field 2 =
 * string message) using the same `ProtoReader`/`forEachField` machinery the source's own
 * response encoder is built on — no separate client library needed. */
function decodeProtoStatus(bytes: Uint8Array): { code: number; message: string } {
  let code = 0;
  let message = '';
  forEachField(bytes, (field, wireType, r) => {
    if (field === 1) code = r.readInt32();
    else if (field === 2) message = r.readString();
    else r.skipValue(wireType);
  });
  return { code, message };
}

/** Decodes an `Export<Signal>ServiceResponse`'s `partial_success` (field 1), if present. */
function decodePartialSuccess(
  bytes: Uint8Array,
): { rejectedCount: bigint; errorMessage: string } | undefined {
  let result: { rejectedCount: bigint; errorMessage: string } | undefined;
  forEachField(bytes, (field, wireType, r) => {
    if (field === 1) {
      let rejectedCount = 0n;
      let errorMessage = '';
      forEachField(r.readBytes(), (innerField, innerWireType, inner) => {
        if (innerField === 1) rejectedCount = inner.readInt64();
        else if (innerField === 2) errorMessage = inner.readString();
        else inner.skipValue(innerWireType);
      });
      result = { rejectedCount, errorMessage };
    } else {
      r.skipValue(wireType);
    }
  });
  return result;
}

async function finishSent(
  harness: ReturnType<typeof createControllableSourceContext>,
): Promise<void> {
  await waitUntil(() => harness.sent.length === 1);
  for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
}

describe('otlp: happy path (protobuf)', () => {
  it('decodes a logs export request and responds 200 with an empty response message', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const responsePromise = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-protobuf');
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    expect(decodePartialSuccess(responseBytes)).toBeUndefined();
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.get('message')).toBe('hello from otlp');
  });

  it('decodes a metrics export request and responds 200', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = Buffer.from(encodeExportMetricsServiceRequest([sampleMetricEvent()]));
    const responsePromise = fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('requests_total');
    expect(events[0]!.value).toEqual({ type: 'gauge', value: 42 });
  });

  it('decodes a traces export request and responds 200', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = Buffer.from(encodeExportTraceServiceRequest([sampleSpanEvent()]));
    const responsePromise = fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const events = harness.sent[0]!.events.filter(isSpanEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('do-work');
    expect(events[0]!.traceIdHex).toBe('01'.repeat(16));
  });
});

describe('otlp: happy path (OTLP/JSON)', () => {
  it('decodes a logs export request and responds 200 with a well-formed JSON body', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = encodeOtlpJsonLogs([sampleLogEvent()]);
    const responsePromise = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const json = (await response.json()) as { partialSuccess?: unknown };
    expect(json.partialSuccess).toBeUndefined();
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events[0]!.get('message')).toBe('hello from otlp');
  });

  it('decodes a metrics export request and responds 200', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = encodeOtlpJsonMetrics([sampleMetricEvent()]);
    const responsePromise = fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.name).toBe('requests_total');
  });

  it('decodes a traces export request and responds 200', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = encodeOtlpJsonTraces([sampleSpanEvent()]);
    const responsePromise = fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const events = harness.sent[0]!.events.filter(isSpanEvent);
    expect(events[0]!.name).toBe('do-work');
  });
});

describe('otlp: content type and decoding errors', () => {
  it('responds 415 for an unsupported Content-Type', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(415);
    const json = (await response.json()) as { code: number; message: string };
    expect(json.code).toBeTypeOf('number');
    expect(json.message).toBeTypeOf('string');
  });

  it('responds 400 with a google.rpc.Status protobuf body for a malformed protobuf request', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    // A length-delimited field 1 tag claiming 5 bytes, with none following: truncated.
    const malformed = Buffer.from([0x0a, 0x05]);
    const response = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body: malformed,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/x-protobuf');
    const status = decodeProtoStatus(new Uint8Array(await response.arrayBuffer()));
    expect(status.code).toBe(3); // INVALID_ARGUMENT
    expect(status.message).toBeTypeOf('string');
    expect(status.message.length).toBeGreaterThan(0);
  });

  it('responds 400 with a google.rpc.Status JSON body for malformed OTLP/JSON', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body: '{not valid json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as { code: number; message: string };
    expect(json.code).toBe(3);
    expect(json.message).toBeTypeOf('string');
  });
});

describe('otlp: gzip and size limits', () => {
  it('decodes a gzip-compressed protobuf request body', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const compressed = gzipSync(Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()])));
    const responsePromise = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body: compressed,
      headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' },
    });
    await finishSent(harness);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events[0]!.get('message')).toBe('hello from otlp');
  });

  it('responds 413 for a body exceeding max_body_size', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0', max_body_size: 8 });
    const body = Buffer.from(
      encodeExportLogsServiceRequest([LogEvent.fromMessage('x'.repeat(1000))]),
    );
    const response = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(response.status).toBe(413);
  });
});

describe('otlp: authentication', () => {
  it('rejects a missing bearer token with 401 and accepts a correct one', async () => {
    const { harness, baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      auth: { strategy: 'bearer', token: 'secret-token' },
    });
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const unauthorized = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(unauthorized.status).toBe(401);

    const responsePromise = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/x-protobuf',
        authorization: 'Bearer secret-token',
      },
    });
    await finishSent(harness);
    expect((await responsePromise).status).toBe(200);
  });
});

describe('otlp: backpressure and acknowledgement outcomes', () => {
  it('responds 503 with Retry-After once the backpressure timeout elapses', async () => {
    const parsed = otlpSource.options.parse({
      address: '127.0.0.1:0',
      backpressure_timeout: 200,
    });
    const handle = (await otlpSource.build(parsed, buildCtx())) as OtlpSourceHandle;
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
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const responsePromise = fetch(`http://127.0.0.1:${addr.port}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
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
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const responsePromise = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('errored');
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
  });

  it('maps a rejected acknowledgement to a permanent 400', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const responsePromise = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('rejected');
    const response = await responsePromise;
    expect(response.status).toBe(400);
    const status = decodeProtoStatus(new Uint8Array(await response.arrayBuffer()));
    expect(status.code).toBe(3);
  });

  it('responds 200 immediately when acknowledgements are off', async () => {
    const { harness, baseUrl } = await startTracked({ address: '127.0.0.1:0' }, false);
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const response = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(response.status).toBe(200);
    expect(harness.sent).toHaveLength(1);
  });

  it('rejects requests over max_concurrent_requests with 429', async () => {
    const { harness, baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      max_concurrent_requests: 1,
    });
    harness.blockSends();
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const first = fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await waitUntil(() => harness.sent.length === 1);
    const second = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).not.toBeNull();
    harness.releaseSends();
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    await first;
  });
});

describe('otlp: graceful shutdown', () => {
  it('finishes an in-flight request before run() resolves, and stops accepting new ones', async () => {
    const parsed = otlpSource.options.parse({ address: '127.0.0.1:0' });
    const handle = (await otlpSource.build(parsed, buildCtx())) as OtlpSourceHandle;
    const harness = createControllableSourceContext();
    harness.blockSends();
    const runPromise = handle.run(harness.ctx);
    await waitUntil(() => handle.address() !== undefined);
    const addr = handle.address()!;
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const inFlight = fetch(`http://127.0.0.1:${addr.port}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
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

describe('otlp: routing', () => {
  it('answers the health endpoint', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it('responds 404 for unknown paths', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/nope`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('responds 405 for GET on an ingest path', async () => {
    const { baseUrl } = await startTracked({ address: '127.0.0.1:0' });
    const response = await fetch(`${baseUrl}/v1/logs`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('honours a configured base_path', async () => {
    const { harness, baseUrl } = await startTracked({
      address: '127.0.0.1:0',
      base_path: '/otlp',
    });
    const body = Buffer.from(encodeExportLogsServiceRequest([sampleLogEvent()]));
    const responsePromise = fetch(`${baseUrl}/otlp/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    await finishSent(harness);
    expect((await responsePromise).status).toBe(200);
    // The default base path is no longer mounted.
    const notFound = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(notFound.status).toBe(404);
  });
});
