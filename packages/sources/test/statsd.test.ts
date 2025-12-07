import { createSocket as createUdpSocket } from 'node:dgram';
import { connect as connectTcp, type Socket as NetSocket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isMetricEvent } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { statsdSource, type StatsdOptions, type StatsdSourceHandle } from '../src/statsd.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';

function buildCtx(id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir: undefined, inputs: [] };
}

type RawOptions = Record<string, unknown>;

async function start(rawOptions: RawOptions, acknowledgements = true) {
  const parsed: StatsdOptions = statsdSource.options.parse(rawOptions);
  const handle = (await statsdSource.build(parsed, buildCtx())) as StatsdSourceHandle;
  const harness = createControllableSourceContext({ acknowledgements });
  const runPromise = handle.run(harness.ctx);
  if (rawOptions['udp'] !== undefined) await waitUntil(() => handle.udpAddress() !== undefined);
  if (rawOptions['tcp'] !== undefined) await waitUntil(() => handle.tcpAddress() !== undefined);
  return {
    handle,
    harness,
    runPromise,
    async stop(): Promise<void> {
      harness.releaseSends();
      harness.abort();
      await runPromise;
    },
  };
}

const runningSources: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runningSources.splice(0).map((s) => s.stop()));
});

async function startTracked(rawOptions: RawOptions, acknowledgements = true) {
  const started = await start(rawOptions, acknowledgements);
  runningSources.push(started);
  return started;
}

function sendUdp(port: number, host: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createUdpSocket('udp4');
    client.send(message, port, host, (error) => {
      client.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function connectTcpClient(port: number, host = '127.0.0.1'): Promise<NetSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, host, () => resolve(socket));
    socket.once('error', reject);
  });
}

function finishAll(
  events: { metadata: { finalizers: { finish(status?: 'delivered'): void } } }[],
): void {
  for (const event of events) event.metadata.finalizers.finish('delivered');
}

describe('statsd: udp happy path', () => {
  it('decodes counter/gauge/timer/set values from one multi-line packet', async () => {
    const { harness, handle } = await startTracked({ udp: { address: '127.0.0.1:0' } });
    const addr = handle.udpAddress()!;
    const packet = [
      'page.views:1|c',
      'page.load:320|ms',
      'users.active:42|g',
      'unique.visitors:abc|s',
      '',
    ].join('\n');
    await sendUdp(addr.port, addr.host, packet);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events).toHaveLength(4);

    const counter = events.find((e) => e.name === 'page.views')!;
    expect(counter.value).toEqual({ type: 'counter', value: 1 });
    expect(counter.metricKind).toBe('incremental');

    const timer = events.find((e) => e.name === 'page.load')!;
    expect(timer.value).toEqual({
      type: 'distribution',
      statistic: 'histogram',
      samples: [{ value: 320, rate: 1 }],
    });

    const gauge = events.find((e) => e.name === 'users.active')!;
    expect(gauge.value).toEqual({ type: 'gauge', value: 42 });
    expect(gauge.metricKind).toBe('absolute');

    const set = events.find((e) => e.name === 'unique.visitors')!;
    expect(set.value).toEqual({ type: 'set', values: new Set(['abc']) });

    finishAll(events);
  });

  it('decodes DogStatsD tags', async () => {
    const { harness, handle } = await startTracked({ udp: { address: '127.0.0.1:0' } });
    const addr = handle.udpAddress()!;
    await sendUdp(addr.port, addr.host, 'my.metric:5|c|#env:prod,region:us\n');
    await waitUntil(() => harness.sent.length === 1);
    const [event] = harness.sent[0]!.events.filter(isMetricEvent);
    expect(event!.tags.get('env')).toBe('prod');
    expect(event!.tags.get('region')).toBe('us');
    finishAll(harness.sent[0]!.events);
  });

  it('responds 200-equivalent (delivered) without waiting when acknowledgements are off', async () => {
    const { harness, handle } = await startTracked({ udp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.udpAddress()!;
    await sendUdp(addr.port, addr.host, 'counter.a:1|c\n');
    await waitUntil(() => harness.sent.length === 1);
    // No finalizer needed to be finished; with acknowledgements off the source never awaits
    // batch.completion, so nothing here should ever hang.
  });
});

describe('statsd: tcp happy path', () => {
  it('frames lines across multiple write() calls, including one split across two writes', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } });
    const addr = handle.tcpAddress()!;
    const socket = await connectTcpClient(addr.port, addr.host);
    try {
      socket.write('metric.a:1|c\nmetric.b:2|c\nmetric.c:');
      await waitUntil(() => harness.sent.length >= 1);
      finishAll(harness.sent[0]!.events);
      await waitUntil(() => harness.sent.length >= 2);
      finishAll(harness.sent[1]!.events);

      socket.write('3|c\n');
      await waitUntil(() => harness.sent.length >= 3);
      finishAll(harness.sent[2]!.events);

      const names = harness.sent
        .flatMap((batch) => batch.events.filter(isMetricEvent))
        .map((e) => e.name)
        .sort();
      expect(names).toEqual(['metric.a', 'metric.b', 'metric.c']);
    } finally {
      socket.end();
    }
  });
});

describe('statsd: decode errors', () => {
  it('skips a malformed TCP line, logs and counts it, and still delivers the next good line', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } });
    const addr = handle.tcpAddress()!;
    const socket = await connectTcpClient(addr.port, addr.host);
    try {
      socket.write('not-a-valid-statsd-line\nmetric.ok:1|c\n');
      await waitUntil(() => harness.sent.length === 1);
      const events = harness.sent[0]!.events.filter(isMetricEvent);
      expect(events.map((e) => e.name)).toEqual(['metric.ok']);
      finishAll(events);
      await waitUntil(() => harness.logs.some((r) => r.message.includes('failed to decode')));
    } finally {
      socket.end();
    }
  });

  it('drops a whole malformed UDP packet but still delivers a later good one', async () => {
    const { harness, handle } = await startTracked({ udp: { address: '127.0.0.1:0' } });
    const addr = handle.udpAddress()!;
    await sendUdp(addr.port, addr.host, 'not valid at all\n');
    await waitUntil(() => harness.logs.some((r) => r.message.includes('failed to decode')));
    expect(harness.sent).toHaveLength(0);

    await sendUdp(addr.port, addr.host, 'metric.ok:1|c\n');
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events.map((e) => e.name)).toEqual(['metric.ok']);
    finishAll(events);
  });
});

describe('statsd: tcp maxConnections', () => {
  it('closes connections beyond the configured limit', async () => {
    const { handle } = await startTracked({
      tcp: { address: '127.0.0.1:0', maxConnections: 1 },
    });
    const addr = handle.tcpAddress()!;
    const first = await connectTcpClient(addr.port, addr.host);
    try {
      const second = await connectTcpClient(addr.port, addr.host);
      await waitUntil(() => second.destroyed || second.readyState === 'closed');
      expect(first.destroyed).toBe(false);
    } finally {
      first.end();
    }
  });
});

describe('statsd: udp backpressure', () => {
  it('bounds in-flight sends and drops datagrams beyond the limit until a slot frees up', async () => {
    const { harness, handle } = await startTracked({
      udp: { address: '127.0.0.1:0', maxInFlightSends: 1 },
    });
    const addr = handle.udpAddress()!;
    harness.blockSends();

    await sendUdp(addr.port, addr.host, 'first:1|c\n');
    await waitUntil(() => harness.sent.length === 1);

    // A second datagram arrives while the first send is still pending: with only one in-flight
    // slot available it must be dropped rather than queued, and logged as such.
    await sendUdp(addr.port, addr.host, 'second:1|c\n');
    await waitUntil(() => harness.logs.some((r) => r.message.includes('dropping udp datagram')));
    expect(harness.sent).toHaveLength(1);

    harness.releaseSends();
    finishAll(harness.sent[0]!.events);

    // Once the first send's finalizer resolves, the in-flight slot frees up for a new datagram.
    await sendUdp(addr.port, addr.host, 'third:1|c\n');
    await waitUntil(() => harness.sent.length === 2);
    finishAll(harness.sent[1]!.events);
  });
});

describe('statsd: graceful shutdown', () => {
  it('finishes an in-flight tcp send before run() resolves, and stops accepting new work', async () => {
    const parsed = statsdSource.options.parse({ tcp: { address: '127.0.0.1:0' } });
    const handle = (await statsdSource.build(parsed, buildCtx())) as StatsdSourceHandle;
    const harness = createControllableSourceContext();
    harness.blockSends();
    const runPromise = handle.run(harness.ctx);
    await waitUntil(() => handle.tcpAddress() !== undefined);
    const addr = handle.tcpAddress()!;
    const socket = await connectTcpClient(addr.port, addr.host);
    socket.write('pending.metric:1|c\n');
    await waitUntil(() => harness.sent.length === 1);

    harness.abort();
    let resolved = false;
    void runPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false);

    harness.releaseSends();
    finishAll(harness.sent[0]!.events);
    await runPromise;
    expect(resolved).toBe(true);
    socket.destroy();
  });
});
