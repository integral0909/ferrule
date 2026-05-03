import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { createSocketSink, type SocketSinkOptions } from '../../src/stream/socket.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

function baseOptions(overrides: Partial<SocketSinkOptions>): SocketSinkOptions {
  return {
    protocol: 'tcp',
    host: '127.0.0.1',
    port: 0,
    encoding: { codec: 'json' },
    framing: { method: 'newline' },
    batch: { max_events: 500, max_size: 1024 * 1024, timeout: 1_000 },
    max_datagram_size: 65_507,
    connect_timeout: 2_000,
    retry: { initial_backoff: 10, max_backoff: 50 },
    ...overrides,
  };
}

/** Resolves `true` if `p` has already settled by the next tick, `false` otherwise, without
 * consuming `p`'s eventual rejection here (the caller still awaits `p` itself afterward). */
function raced(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function startTcpServer(): Promise<{ port: number; received: Promise<Buffer> }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolveReceived!: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => {
      resolveReceived = r;
    });
    const server = net.createServer((socket) => {
      socket.on('data', (d: Buffer) => {
        chunks.push(d);
        resolveReceived(Buffer.concat(chunks));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      cleanups.push(() => new Promise((r) => server.close(() => r())));
      resolve({ port, received });
    });
  });
}

function startUdpServer(): Promise<{ port: number; received: Promise<Buffer> }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let resolveReceived!: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => {
      resolveReceived = r;
    });
    socket.on('message', (msg) => resolveReceived(msg));
    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address();
      cleanups.push(() => new Promise((r) => socket.close(() => r())));
      resolve({ port: address.port, received });
    });
  });
}

describe('socket sink (TCP)', () => {
  it('connects, writes newline-framed events, and delivers them', async () => {
    const { port, received } = await startTcpServer();
    const sink = createSocketSink(baseOptions({ protocol: 'tcp', port }));
    const ctx = createTestSinkContext();
    const events = [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')];
    const completions = events.map(withFinalizer);

    const running = sink.run(ctx.ctx);
    await ctx.feed(events);
    ctx.close();
    await running;

    const buf = await received;
    expect(buf.toString('utf8')).toBe('{"message":"a"}\n{"message":"b"}\n');
    for (const c of completions) await expect(c).resolves.toBe('delivered');
  });

  it('retries (backoff driven by the manual clock) until the server starts listening, then delivers', async () => {
    // Reserve a port with nothing listening on it yet.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((r) => probe.close(() => r()));

    const sink = createSocketSink(
      baseOptions({ protocol: 'tcp', port, retry: { initial_backoff: 5, max_backoff: 20 } }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('delayed');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();

    // Let the first connection attempt fail (ECONNREFUSED, real loopback I/O) before the server
    // starts listening, so the send genuinely has to go through the retry path.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const server = net.createServer((socket) => {
      socket.on('data', () => undefined);
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(() => r())));

    // The backoff sleep between attempts goes through ctx.clock; advance it until the retried
    // connection (now against a live server) succeeds and the batch is delivered. Real I/O still
    // needs real event-loop turns between advances, so wait a little between them too.
    for (let i = 0; i < 100 && !(await raced(running)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ctx.clock.advance(20);
    }
    await running;
    await expect(completion).resolves.toBe('delivered');
  });

  it('healthcheck succeeds against a listening TCP server', async () => {
    const { port } = await startTcpServer();
    const sink = createSocketSink(baseOptions({ protocol: 'tcp', port }));
    const ctx = createTestSinkContext();
    await expect(sink.healthcheck?.(ctx.ctx)).resolves.toBeUndefined();
  });
});

describe('socket sink (UDP)', () => {
  it('sends one datagram per event', async () => {
    const { port, received } = await startUdpServer();
    const sink = createSocketSink(
      baseOptions({ protocol: 'udp', port, encoding: { codec: 'text' } }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('hello-udp');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    const msg = await received;
    expect(msg.toString('utf8')).toBe('hello-udp');
    await expect(completion).resolves.toBe('delivered');
  });

  it('rejects an oversize UDP datagram instead of sending it', async () => {
    const { port } = await startUdpServer();
    const sink = createSocketSink(
      baseOptions({ protocol: 'udp', port, encoding: { codec: 'text' }, max_datagram_size: 4 }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('this is way too long for the limit');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('rejected');
  });
});
