import { describe, expect, it, vi } from 'vitest';
import { MetricEvent } from '@ferrule/core';
import { createTestSinkContext, type Sink } from '@ferrule/runtime';
import {
  prometheusExporterSink,
  prometheusExporterSinkOptions,
} from '../../src/http/sinks/prometheus-exporter.js';
import { testBuildContext, withNotifier } from './helpers.js';

async function listenAndGetPort(
  sink: Sink,
  ctx: ReturnType<typeof createTestSinkContext>['ctx'],
  logs: ReturnType<typeof testBuildContext>['logs'],
): Promise<{ run: Promise<void>; port: number }> {
  const run = sink.run(ctx);
  await vi.waitFor(
    () => {
      const record = logs.find((l) => l.message.includes('listening'));
      if (record === undefined) throw new Error('not listening yet');
    },
    // vitest's default budget here is 1s, the tightest waiter in the suite, for a real HTTP
    // server binding a port. It polls, so starvation should only make it slower — give it room
    // to actually be slower instead of failing a test whose subject isn't timing at all.
    { timeout: 10_000 },
  );
  const record = logs.find((l) => l.message.includes('listening'))!;
  return { run, port: record.fields['port'] as number };
}

/** Two incremental exponential points at different scales whose buckets overlap on (1, 2]. */
function exponentialPointsAtTwoScales(): [MetricEvent, MetricEvent] {
  const point = (scale: number, counts: number[], sum: number) =>
    new MetricEvent({
      name: 'latency',
      kind: 'incremental',
      value: {
        type: 'exponential_histogram',
        scale,
        zeroCount: 0,
        zeroThreshold: 0,
        positive: { offset: 0, counts },
        negative: { offset: 0, counts: [] },
        count: counts.reduce((a, b) => a + b, 0),
        sum,
      },
    });
  // Scale 1: (1, √2] holds 1 and (√2, 2] holds 2. Scale 0: (1, 2] holds 4.
  return [point(1, [1, 2], 4), point(0, [4], 6)];
}

/** An exponential point whose boundaries overflow a double: at scale -10, bucket 1 ends at 2^2048. */
function overflowingExponential(): MetricEvent {
  return new MetricEvent({
    name: 'huge',
    kind: 'incremental',
    value: {
      type: 'exponential_histogram',
      scale: -10,
      zeroCount: 0,
      zeroThreshold: 0,
      positive: { offset: 1, counts: [1] },
      negative: { offset: 0, counts: [] },
      count: 1,
      sum: 1,
    },
  });
}

describe('prometheus_exporter sink', () => {
  it('serves an ephemeral port and returns 404 for anything but GET <path>', async () => {
    const buildCtx = testBuildContext();
    const options = prometheusExporterSinkOptions.parse({ listen_address: '127.0.0.1:0' });
    const sink = await prometheusExporterSink.build(options, buildCtx.ctx);
    const harness = createTestSinkContext();
    const { run, port } = await listenAndGetPort(sink, harness.ctx, buildCtx.logs);
    expect(port).toBeGreaterThan(0);

    const notFound = await fetch(`http://127.0.0.1:${port}/wrong-path`);
    expect(notFound.status).toBe(404);

    harness.close();
    await run;
  });

  it('serves the latest absolute gauge value and accumulates an incremental counter', async () => {
    const buildCtx = testBuildContext();
    const options = prometheusExporterSinkOptions.parse({ listen_address: '127.0.0.1:0' });
    const sink = await prometheusExporterSink.build(options, buildCtx.ctx);
    const harness = createTestSinkContext();
    const { run, port } = await listenAndGetPort(sink, harness.ctx, buildCtx.logs);

    const gauge = withNotifier(
      new MetricEvent({ name: 'temp', kind: 'absolute', value: { type: 'gauge', value: 21.5 } }),
    );
    const c1 = withNotifier(
      new MetricEvent({ name: 'hits', kind: 'incremental', value: { type: 'counter', value: 4 } }),
    );
    const c2 = withNotifier(
      new MetricEvent({ name: 'hits', kind: 'incremental', value: { type: 'counter', value: 6 } }),
    );
    await harness.feed([gauge.event, c1.event]);
    await harness.feed([c2.event]);

    await expect(gauge.completion).resolves.toBe('delivered');
    await expect(c1.completion).resolves.toBe('delivered');
    await expect(c2.completion).resolves.toBe('delivered');

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(text).toContain('temp 21.5');
    expect(text).toContain('hits 10'); // 4 + 6 accumulated

    harness.close();
    await run;
  });

  it('merges exponential points at different scales and converts only when scraped', async () => {
    const buildCtx = testBuildContext();
    const options = prometheusExporterSinkOptions.parse({ listen_address: '127.0.0.1:0' });
    const sink = await prometheusExporterSink.build(options, buildCtx.ctx);
    const harness = createTestSinkContext();
    const { run, port } = await listenAndGetPort(sink, harness.ctx, buildCtx.logs);

    const [fine, coarse] = exponentialPointsAtTwoScales();
    await harness.feed([fine]);
    const first = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(first).toContain(`latency_bucket{le="${Math.SQRT2}"} 1`);
    expect(first).toContain('latency_bucket{le="2"} 3');

    await harness.feed([coarse]);
    const merged = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    // 3 (downscaled from scale 1) + 4. Converting before merging would restart the series at 4.
    expect(merged).toContain('# TYPE latency histogram');
    expect(merged).not.toContain(`le="${Math.SQRT2}"`);
    expect(merged).toContain('latency_bucket{le="2"} 7');
    expect(merged).toContain('latency_bucket{le="+Inf"} 7');
    expect(merged).toContain('latency_sum 10');
    expect(merged).toContain('latency_count 7');

    harness.close();
    await run;
  });

  it('rejects an exponential point with no finite explicit form, and keeps serving the rest', async () => {
    const buildCtx = testBuildContext();
    const options = prometheusExporterSinkOptions.parse({ listen_address: '127.0.0.1:0' });
    const sink = await prometheusExporterSink.build(options, buildCtx.ctx);
    const harness = createTestSinkContext();
    const { run, port } = await listenAndGetPort(sink, harness.ctx, buildCtx.logs);

    const bad = withNotifier(overflowingExponential());
    const good = withNotifier(
      new MetricEvent({ name: 'temp', kind: 'absolute', value: { type: 'gauge', value: 3 } }),
    );
    await harness.feed([bad.event, good.event]);
    await expect(bad.completion).resolves.toBe('rejected');
    await expect(good.completion).resolves.toBe('delivered');

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('temp 3');
    expect(text).not.toContain('huge');

    harness.close();
    await run;
  });

  it('expires a series once it has not been observed within the staleness bound', async () => {
    const buildCtx = testBuildContext();
    const options = prometheusExporterSinkOptions.parse({
      listen_address: '127.0.0.1:0',
      stale_bound: 1_000,
    });
    const sink = await prometheusExporterSink.build(options, buildCtx.ctx);
    const harness = createTestSinkContext();
    const { run, port } = await listenAndGetPort(sink, harness.ctx, buildCtx.logs);

    await harness.feed([
      new MetricEvent({ name: 'fleeting', kind: 'absolute', value: { type: 'gauge', value: 1 } }),
    ]);
    const soon = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(soon).toContain('fleeting');

    await harness.clock.advance(2_000);
    const later = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(later).not.toContain('fleeting');

    harness.close();
    await run;
  });
});
