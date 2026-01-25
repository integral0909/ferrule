import { afterEach, describe, expect, it } from 'vitest';
import { MetricEvent, Timestamp } from '@ferrule/core';
import { ProtoReader } from '@ferrule/codecs';
import { createTestSinkContext } from '@ferrule/runtime';
import {
  prometheusRemoteWriteSink,
  prometheusRemoteWriteSinkOptions,
} from '../../src/http/sinks/prometheus-remote-write.js';
import { MetricAccumulator } from '../../src/http/prom-remote-write.js';
import { snappyDecompress } from '../../src/http/snappy.js';
import { startServer, testBuildContext, withNotifier, type TestServer } from './helpers.js';

interface DecodedSeries {
  labels: Record<string, string>;
  samples: { value: number; timestampMs: number }[];
}

function decodeWriteRequest(bytes: Uint8Array): DecodedSeries[] {
  const series: DecodedSeries[] = [];
  const reader = new ProtoReader(bytes);
  while (!reader.atEnd()) {
    const { field, wireType } = reader.readTag();
    if (field !== 1) {
      reader.skipValue(wireType);
      continue;
    }
    const ts = reader.subReader();
    const labels: Record<string, string> = {};
    const samples: { value: number; timestampMs: number }[] = [];
    while (!ts.atEnd()) {
      const inner = ts.readTag();
      if (inner.field === 1) {
        const label = ts.subReader();
        let name = '';
        let value = '';
        while (!label.atEnd()) {
          const t = label.readTag();
          if (t.field === 1) name = label.readString();
          else if (t.field === 2) value = label.readString();
          else label.skipValue(t.wireType);
        }
        labels[name] = value;
      } else if (inner.field === 2) {
        const sample = ts.subReader();
        let value = 0;
        let timestampMs = 0;
        while (!sample.atEnd()) {
          const t = sample.readTag();
          if (t.field === 1) value = sample.readDouble();
          else if (t.field === 2) timestampMs = Number(sample.readInt64());
          else sample.skipValue(t.wireType);
        }
        samples.push({ value, timestampMs });
      } else {
        ts.skipValue(inner.wireType);
      }
    }
    series.push({ labels, samples });
  }
  return series;
}

let server: TestServer | undefined;
let received: DecodedSeries[][] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  received = [];
});

async function startCapturingServer(): Promise<TestServer> {
  const s = await startServer((_req, res, body) => {
    const decompressed = snappyDecompress(body);
    received.push(decodeWriteRequest(decompressed));
    res.writeHead(200);
    res.end();
  });
  return s;
}

function counter(name: string, value: number, tags: Record<string, string> = {}): MetricEvent {
  return new MetricEvent({ name, tags, kind: 'incremental', value: { type: 'counter', value } });
}

describe('prometheus_remote_write sink', () => {
  it('sends the required headers and a snappy-compressed protobuf body', async () => {
    server = await startCapturingServer();
    const options = prometheusRemoteWriteSinkOptions.parse({ url: server.url });
    const sink = await prometheusRemoteWriteSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([
      new MetricEvent({ name: 'up', kind: 'absolute', value: { type: 'gauge', value: 1 } }),
    ]);
    harness.close();
    await run;

    const req = server.requests[0]!;
    expect(req.headers['content-type']).toBe('application/x-protobuf');
    expect(req.headers['content-encoding']).toBe('snappy');
    expect(req.headers['x-prometheus-remote-write-version']).toBe('0.1.0');
    expect(received[0]).toHaveLength(1);
    expect(received[0]![0]!.labels).toEqual({ __name__: 'up' });
    expect(received[0]![0]!.samples[0]!.value).toBe(1);
  });

  it('accumulates incremental counters across events into a running absolute total', async () => {
    server = await startCapturingServer();
    const options = prometheusRemoteWriteSinkOptions.parse({
      url: server.url,
      batch: { maxEvents: 1 },
    });
    const sink = await prometheusRemoteWriteSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([counter('requests_total', 5), counter('requests_total', 3)]);
    harness.close();
    await run;

    expect(received).toHaveLength(2);
    expect(received[0]![0]!.samples[0]!.value).toBe(5);
    expect(received[1]![0]!.samples[0]!.value).toBe(8); // 5 + 3 accumulated
  });

  it('restarts accumulation once the staleness bound has elapsed', () => {
    // Exercised directly on `MetricAccumulator`, not through the full sink+HTTP+ManualClock
    // stack: the batcher flushes asynchronously, so there is no reliable synchronization point
    // between "advance the clock" and "the next event's `encode()` reads it" at the integration
    // level, whereas the accumulator's own `nowMs` contract is synchronous and deterministic.
    const accumulator = new MetricAccumulator(100);
    const event = counter('c', 5);
    expect(accumulator.accumulate(event, 0)).toEqual({ type: 'counter', value: 5 });
    expect(accumulator.accumulate(counter('c', 3), 50)).toEqual({ type: 'counter', value: 8 });
    // 50 -> 1050 is a 1000ms gap, past the 100ms staleness bound: restarts from this value alone.
    expect(accumulator.accumulate(counter('c', 3), 1_050)).toEqual({ type: 'counter', value: 3 });
  });

  it('expands a histogram into cumulative _bucket/_sum/_count series', async () => {
    server = await startCapturingServer();
    const options = prometheusRemoteWriteSinkOptions.parse({ url: server.url });
    const sink = await prometheusRemoteWriteSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([
      new MetricEvent({
        name: 'latency',
        kind: 'absolute',
        value: {
          type: 'histogram',
          buckets: [
            { upperLimit: 0.1, count: 2 },
            { upperLimit: 1, count: 3 },
          ],
          count: 6,
          sum: 4.2,
        },
      }),
    ]);
    harness.close();
    await run;

    const byName = (name: string, le?: string) =>
      received[0]!.find(
        (s) => s.labels['__name__'] === name && (le === undefined || s.labels['le'] === le),
      );
    expect(byName('latency_bucket', '0.1')!.samples[0]!.value).toBe(2);
    expect(byName('latency_bucket', '1')!.samples[0]!.value).toBe(5); // cumulative: 2 + 3
    expect(byName('latency_bucket', '+Inf')!.samples[0]!.value).toBe(6);
    expect(byName('latency_sum')!.samples[0]!.value).toBe(4.2);
    expect(byName('latency_count')!.samples[0]!.value).toBe(6);
  });

  it('expands a summary into per-quantile series plus _sum/_count', async () => {
    server = await startCapturingServer();
    const options = prometheusRemoteWriteSinkOptions.parse({ url: server.url });
    const sink = await prometheusRemoteWriteSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([
      new MetricEvent({
        name: 'req_duration',
        kind: 'absolute',
        value: {
          type: 'summary',
          quantiles: [
            { quantile: 0.5, value: 10 },
            { quantile: 0.99, value: 50 },
          ],
          count: 100,
          sum: 1234,
        },
      }),
    ]);
    harness.close();
    await run;

    const p50 = received[0]!.find((s) => s.labels['quantile'] === '0.5');
    expect(p50!.samples[0]!.value).toBe(10);
    const count = received[0]!.find((s) => s.labels['__name__'] === 'req_duration_count');
    expect(count!.samples[0]!.value).toBe(100);
  });

  it('rejects set/distribution metrics (no remote-write representation) without failing the batch', async () => {
    server = await startCapturingServer();
    const options = prometheusRemoteWriteSinkOptions.parse({ url: server.url });
    const sink = await prometheusRemoteWriteSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(
      new MetricEvent({
        name: 'uniques',
        kind: 'incremental',
        value: { type: 'set', values: new Set(['a']) },
      }),
    );
    await harness.feed([event]);
    harness.close();
    await run;
    await expect(completion).resolves.toBe('rejected');
    expect(server.requests).toHaveLength(0);
  });

  it('uses the event timestamp when present, else the batch flush time', async () => {
    server = await startCapturingServer();
    const options = prometheusRemoteWriteSinkOptions.parse({ url: server.url });
    const sink = await prometheusRemoteWriteSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const event = new MetricEvent({
      name: 'g',
      kind: 'absolute',
      value: { type: 'gauge', value: 1 },
      timestamp: Timestamp.fromMillis(123_456),
    });
    await harness.feed([event]);
    harness.close();
    await run;
    expect(received[0]![0]!.samples[0]!.timestampMs).toBe(123_456);
  });
});
