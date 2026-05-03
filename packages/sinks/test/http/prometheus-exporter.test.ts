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
  await vi.waitFor(() => {
    const record = logs.find((l) => l.message.includes('listening'));
    if (record === undefined) throw new Error('not listening yet');
  });
  const record = logs.find((l) => l.message.includes('listening'))!;
  return { run, port: record.fields['port'] as number };
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
