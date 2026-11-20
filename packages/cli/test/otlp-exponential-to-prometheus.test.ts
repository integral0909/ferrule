import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtoWriter } from '@ferrule/codecs';
import { SystemClock } from '@ferrule/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_OK } from '../src/exit-codes.js';
import { createFakeEnvironment } from './support/environment.js';

/**
 * End to end through `ferrule run`: an OTLP/HTTP client sends exponential histograms (built by
 * hand with `ProtoWriter`, independently of Ferrule's own OTLP encoder) to the `otlp` source, and
 * the `prometheus_exporter` sink serves them as classic Prometheus histograms.
 */

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  describeFailure: () => string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${describeFailure()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TEMPORALITY_DELTA = 1;

/** One `ExportMetricsServiceRequest` holding a single delta `ExponentialHistogram` point. */
function exponentialRequest(point: {
  scale: number;
  zeroCount: bigint;
  positiveOffset: number;
  positiveCounts: bigint[];
  sum: number;
}): Uint8Array {
  const count = point.zeroCount + point.positiveCounts.reduce((a, b) => a + b, 0n);
  const dp = new ProtoWriter();
  dp.writeMessage(1, (kv) => {
    kv.writeString(1, 'route');
    kv.writeMessage(2, (v) => v.writeString(1, '/checkout'));
  });
  dp.writeFixed64(3, BigInt(Date.now()) * 1_000_000n);
  dp.writeFixed64(4, count);
  dp.writeDouble(5, point.sum);
  dp.writeZigZag32(6, point.scale);
  dp.writeFixed64(7, point.zeroCount);
  dp.writeMessage(8, (b) => {
    b.writeZigZag32(1, point.positiveOffset);
    b.writePacked(2, point.positiveCounts, (item, c) => item.writeRawVarint(c));
  });
  const request = new ProtoWriter();
  request.writeMessage(1, (rm) =>
    rm.writeMessage(2, (sm) =>
      sm.writeMessage(2, (metric) => {
        metric.writeString(1, 'latency');
        metric.writeMessage(10, (h) => {
          h.writeMessage(1, (child) => child.writeRaw(dp.finish()));
          h.writeInt32(2, TEMPORALITY_DELTA);
        });
      }),
    ),
  );
  return request.finish();
}

describe('OTLP exponential histograms → prometheus_exporter, end to end', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-exp-hist-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges delta points at different scales and serves them as explicit buckets', async () => {
    const file = join(dir, 'pipeline.yaml');
    await writeFile(
      file,
      [
        'sources:',
        '  otel:',
        '    type: otlp',
        "    address: '127.0.0.1:0'",
        'sinks:',
        '  prom:',
        '    type: prometheus_exporter',
        '    inputs: [otel]',
        "    listen_address: '127.0.0.1:0'",
        '',
      ].join('\n'),
    );
    const env = createFakeEnvironment({
      argv: ['run', '-c', file],
      cwd: dir,
      clock: new SystemClock(),
    });
    const runPromise = runCli(env);

    const portAfter = (prefix: string): RegExp => new RegExp(`${prefix}[^\\n]*?port\\D+(\\d+)`);
    await waitUntil(
      () =>
        portAfter('otlp: listening').test(env.stderrText()) &&
        portAfter('prometheus_exporter: listening').test(env.stderrText()),
      () => env.stderrText(),
    );
    const otlpPort = Number(portAfter('otlp: listening').exec(env.stderrText())![1]);
    const promPort = Number(portAfter('prometheus_exporter: listening').exec(env.stderrText())![1]);

    const post = async (body: Uint8Array): Promise<void> => {
      const res = await fetch(`http://127.0.0.1:${otlpPort}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body,
      });
      expect(res.status).toBe(200);
    };
    let scraped = '';
    const scrape = async (): Promise<string> => {
      scraped = await (await fetch(`http://127.0.0.1:${promPort}/metrics`)).text();
      return scraped;
    };

    // Scale 1: one observation at zero, 1 in (1, √2], 2 in (√2, 2].
    await post(
      exponentialRequest({
        scale: 1,
        zeroCount: 1n,
        positiveOffset: 0,
        positiveCounts: [1n, 2n],
        sum: 4,
      }),
    );
    await waitUntil(
      async () => (await scrape()).includes('latency_count{route="/checkout"} 4'),
      () => scraped,
    );
    expect(scraped).toContain(`latency_bucket{route="/checkout",le="${Math.SQRT2}"} 2`);

    // Scale 0: 4 in (1, 2] and 1 in (2, 4]. Merged at scale 0 before conversion, so (1, √2]
    // disappears and (1, 2] holds 3 + 4.
    await post(
      exponentialRequest({
        scale: 0,
        zeroCount: 0n,
        positiveOffset: 0,
        positiveCounts: [4n, 1n],
        sum: 9,
      }),
    );
    await waitUntil(
      async () => (await scrape()).includes('latency_count{route="/checkout"} 9'),
      () => scraped,
    );
    const lines = scraped
      .split('\n')
      .filter((l) => l.startsWith('latency') || l.includes(' latency'));
    expect(lines).toEqual([
      '# TYPE latency histogram',
      'latency_bucket{route="/checkout",le="0"} 1',
      'latency_bucket{route="/checkout",le="2"} 8',
      'latency_bucket{route="/checkout",le="4"} 9',
      'latency_bucket{route="/checkout",le="+Inf"} 9',
      'latency_sum{route="/checkout"} 13',
      'latency_count{route="/checkout"} 9',
    ]);

    env.fakeSignals.emit('SIGTERM');
    expect(await runPromise).toBe(EXIT_OK);
  });
});
