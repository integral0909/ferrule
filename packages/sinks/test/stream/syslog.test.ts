import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { parseSyslog5424 } from '@ferrule/codecs';
import { createTestSinkContext } from '@ferrule/runtime';
import { createSyslogSink, type SyslogSinkOptions } from '../../src/stream/syslog.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

function baseOptions(overrides: Partial<SyslogSinkOptions>): SyslogSinkOptions {
  return {
    protocol: 'tcp',
    host: '127.0.0.1',
    port: 0,
    framing: 'octet_counting',
    default_facility: 1,
    default_severity: 6,
    app_name: 'ferrule',
    batch: { max_events: 500, max_size: 1024 * 1024, timeout: 1_000 },
    max_datagram_size: 65_507,
    connect_timeout: 2_000,
    retry: { initial_backoff: 10, max_backoff: 50 },
    ...overrides,
  };
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

/** Strips one octet-counting frame ("<len> " prefix) and parses the RFC 5424 message. */
function parseOctetCounted(buf: Buffer): ReturnType<typeof parseSyslog5424> {
  const text = buf.toString('utf8');
  const spaceIdx = text.indexOf(' ');
  const len = Number(text.slice(0, spaceIdx));
  const msg = text.slice(spaceIdx + 1, spaceIdx + 1 + len);
  return parseSyslog5424(msg);
}

describe('syslog sink', () => {
  it('sends an RFC 5424 message over TCP with octet-counting framing', async () => {
    const { port, received } = await startTcpServer();
    const sink = createSyslogSink(baseOptions({ protocol: 'tcp', port, app_name: 'myapp' }));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ message: 'hello syslog' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    const parsed = parseOctetCounted(await received);
    expect(parsed.appName).toBe('myapp');
    expect(parsed.message).toBe('hello syslog');
    expect(parsed.facility).toBe(1);
    expect(parsed.severity).toBe(6);
    await expect(completion).resolves.toBe('delivered');
  });

  it('maps a textual level field to severity via level_map', async () => {
    const { port, received } = await startTcpServer();
    const sink = createSyslogSink(baseOptions({ protocol: 'tcp', port, level_field: ['level'] }));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ message: 'oops', level: 'error' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    const parsed = parseOctetCounted(await received);
    expect(parsed.severity).toBe(3); // "error" -> 3 per the default level map
    await expect(completion).resolves.toBe('delivered');
  });

  it('reads an explicit numeric facility field, overriding the default', async () => {
    const { port, received } = await startTcpServer();
    const sink = createSyslogSink(
      baseOptions({ protocol: 'tcp', port, facility_field: ['facility'], default_facility: 1 }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ message: 'x', facility: 16n }); // local0
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    const parsed = parseOctetCounted(await received);
    expect(parsed.facility).toBe(16);
    await expect(completion).resolves.toBe('delivered');
  });

  it('sends one datagram per event over UDP with no extra framing', async () => {
    const { port, received } = await startUdpServer();
    const sink = createSyslogSink(baseOptions({ protocol: 'udp', port }));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ message: 'udp message' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    const parsed = parseSyslog5424(await received);
    expect(parsed.message).toBe('udp message');
    await expect(completion).resolves.toBe('delivered');
  });

  it('includes structured data from the "structured_data" field', async () => {
    const { port, received } = await startTcpServer();
    const sink = createSyslogSink(baseOptions({ protocol: 'tcp', port }));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({
      message: 'with sd',
      structured_data: { exampleSDID: { iut: '3', eventSource: 'App' } },
    });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    const parsed = parseOctetCounted(await received);
    expect(parsed.structuredData.get('exampleSDID')?.get('iut')).toBe('3');
    expect(parsed.structuredData.get('exampleSDID')?.get('eventSource')).toBe('App');
    await expect(completion).resolves.toBe('delivered');
  });
});
