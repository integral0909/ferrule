/**
 * `statsd`: receives StatsD/DogStatsD metrics over UDP and/or TCP. Wire parsing (sampling rates,
 * DogStatsD's multi-value and tag extensions) is entirely owned by `@ferrule/codecs`'s `statsd`
 * codec — this source only owns the socket plumbing: binding, per-connection line framing,
 * backpressure, and acknowledgement-aware shutdown.
 *
 * StatsD has no reply protocol (unlike `http_server`, nothing here ever writes a response), but a
 * `BatchNotifier` is still created for every received datagram/line so that, with acknowledgements
 * enabled, this source observes real end-to-end delivery outcomes and backpressure the same way an
 * acknowledged protocol would — the same reasoning that applies to a line-oriented `syslog`
 * receiver.
 */
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import { createServer, type Server as NetServer, type Socket as NetSocket } from 'node:net';
import { BatchNotifier, FerruleError, type Event } from '@ferrule/core';
import { defaultCodecs, NewlineFramer, type Decoder } from '@ferrule/codecs';
import { defineSource, Metrics, type Source, type SourceContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import type { SocketAddress } from '@ferrule/schema';

const udpOptions = s.object({
  address: s
    .socketAddress(true)
    .default({ host: '0.0.0.0', port: 8125 })
    .describe('UDP address to listen on. Port 0 binds an OS-assigned ephemeral port.')
    .example('0.0.0.0:8125'),
  max_packet_size: s
    .byteSize()
    .default(65_507)
    .describe('Maximum UDP datagram size accepted; larger datagrams are discarded.'),
  max_in_flight_sends: s
    .integer({ min: 1 })
    .default(256)
    .describe(
      'Maximum number of `output.send` calls in flight at once for datagrams received on this ' +
        'socket. UDP has no flow control to signal a sender to slow down, so datagrams received ' +
        'beyond this bound are dropped immediately (counted and logged) rather than queued ' +
        'without limit.',
    ),
});

const tcpOptions = s.object({
  address: s
    .socketAddress(true)
    .default({ host: '0.0.0.0', port: 8125 })
    .describe('TCP address to listen on. Port 0 binds an OS-assigned ephemeral port.')
    .example('0.0.0.0:8125'),
  max_connections: s
    .integer({ min: 1 })
    .default(1024)
    .describe(
      'Maximum simultaneous TCP connections; additional connections are closed immediately.',
    ),
  max_line_length: s
    .byteSize()
    .default(64 * 1024)
    .describe('Maximum length of one StatsD line read over TCP.'),
});

const options = s
  .object({
    udp: udpOptions.optional().describe('Enables the UDP listener.'),
    tcp: tcpOptions.optional().describe('Enables the TCP listener.'),
    decoding: s
      .unknown()
      .optional()
      .describe('Options passed through to the StatsD decoder (e.g. maxLines, maxTags).'),
  })
  .refine(
    (v) => v.udp !== undefined || v.tcp !== undefined,
    'at least one of "udp" or "tcp" must be configured',
  );

export type StatsdOptions = Infer<typeof options>;
export type StatsdUdpOptions = Infer<typeof udpOptions>;
export type StatsdTcpOptions = Infer<typeof tcpOptions>;

/** Handle returned by {@link statsdSource}'s `build`, beyond the fixed `Source` contract: the
 * addresses each configured listener actually bound to, for tests that listen on port 0. */
export interface StatsdSourceHandle extends Source {
  udpAddress(): SocketAddress | undefined;
  tcpAddress(): SocketAddress | undefined;
}

interface StatsdMetrics {
  readonly errors: { increment(by?: number): void };
  readonly udpPacketsTotal: { increment(by?: number): void };
  readonly udpDroppedTotal: { increment(by?: number): void };
  readonly tcpConnectionsTotal: { increment(by?: number): void };
  readonly tcpConnectionsRejectedTotal: { increment(by?: number): void };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decodes one StatsD "packet" (a whole UDP datagram, or one TCP line treated as its own
 * one-line packet) and delivers the resulting events as a single unit of work: one
 * `BatchNotifier` covering every event decoded from it, sealed once, sent once. A malformed
 * packet/line is logged, counted, and skipped — it never throws out of this function. */
async function processPacket(
  frame: Uint8Array,
  decoder: Decoder,
  ctx: SourceContext,
  metrics: StatsdMetrics,
  logContext: Record<string, unknown>,
): Promise<void> {
  let events: Event[];
  try {
    events = decoder.decode(frame);
  } catch (error) {
    if (!(error instanceof FerruleError)) throw error;
    metrics.errors.increment();
    ctx.logger.warn('statsd: failed to decode', { ...logContext, error: error.message });
    return;
  }
  if (events.length === 0) return;

  const batch = new BatchNotifier();
  for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();

  await ctx.output.send(events);
  if (ctx.acknowledgements) await batch.completion;
}

function startUdp(
  udpOpts: StatsdUdpOptions,
  decoder: Decoder,
  ctx: SourceContext,
  metrics: StatsdMetrics,
): Promise<{ address: SocketAddress; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    let shuttingDown = false;
    const inFlight = new Set<Promise<void>>();
    const socket: DgramSocket = createSocket(udpOpts.address.host.includes(':') ? 'udp6' : 'udp4');

    socket.on('error', (error) => {
      ctx.logger.error('statsd: udp socket error', { error: errorMessage(error) });
    });

    socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      if (shuttingDown) return;
      metrics.udpPacketsTotal.increment();
      if (msg.length > udpOpts.max_packet_size) {
        metrics.errors.increment();
        ctx.logger.warn('statsd: udp datagram exceeds max_packet_size', {
          size: msg.length,
          from: `${rinfo.address}:${rinfo.port}`,
        });
        return;
      }
      if (inFlight.size >= udpOpts.max_in_flight_sends) {
        metrics.udpDroppedTotal.increment();
        ctx.logger.warn('statsd: dropping udp datagram; max in-flight sends reached', {
          from: `${rinfo.address}:${rinfo.port}`,
          max_in_flight_sends: udpOpts.max_in_flight_sends,
        });
        return;
      }
      const work = processPacket(msg, decoder, ctx, metrics, {
        protocol: 'udp',
        from: `${rinfo.address}:${rinfo.port}`,
      }).catch((error: unknown) => {
        ctx.logger.error('statsd: unhandled udp processing error', { error: errorMessage(error) });
      });
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    });

    socket.once('error', reject);
    socket.bind(udpOpts.address.port, udpOpts.address.host, () => {
      socket.removeListener('error', reject);
      const bound = socket.address();
      const address: SocketAddress = { host: bound.address, port: bound.port };
      ctx.logger.info('statsd: udp listening', { address });
      resolve({
        address,
        stop: async () => {
          shuttingDown = true;
          const closed = new Promise<void>((res) => socket.once('close', res));
          socket.close();
          await closed;
          await Promise.all(inFlight);
        },
      });
    });
  });
}

function startTcp(
  tcpOpts: StatsdTcpOptions,
  decoder: Decoder,
  ctx: SourceContext,
  metrics: StatsdMetrics,
): Promise<{ address: SocketAddress; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    let shuttingDown = false;
    const sockets = new Set<NetSocket>();
    const inFlight = new Set<Promise<void>>();
    const server: NetServer = createServer();

    server.on('connection', (socket: NetSocket) => {
      if (shuttingDown) {
        socket.destroy();
        return;
      }
      if (sockets.size >= tcpOpts.max_connections) {
        metrics.tcpConnectionsRejectedTotal.increment();
        socket.destroy();
        return;
      }
      sockets.add(socket);
      metrics.tcpConnectionsTotal.increment();
      const framer = new NewlineFramer({
        maxLineLength: tcpOpts.max_line_length,
        onOversize: 'error',
      });
      const peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;

      const processFrames = async (frames: Uint8Array[]): Promise<void> => {
        for (const frame of frames) {
          if (frame.length === 0) continue;
          const work = processPacket(frame, decoder, ctx, metrics, { protocol: 'tcp', from: peer });
          inFlight.add(work);
          try {
            await work;
          } finally {
            inFlight.delete(work);
          }
        }
      };

      socket.on('data', (chunk: Buffer) => {
        if (shuttingDown) return;
        let frames: Uint8Array[];
        try {
          frames = framer.push(chunk);
        } catch (error) {
          if (!(error instanceof FerruleError)) throw error;
          metrics.errors.increment();
          ctx.logger.warn('statsd: tcp line exceeds max_line_length', {
            from: peer,
            error: error.message,
          });
          framer.reset();
          return;
        }
        if (frames.length === 0) return;
        // Backpressure: pause the socket for the duration of this chunk's sends so a slow
        // downstream naturally throttles the sender, then resume once every decoded line's
        // `output.send` (and, with acknowledgements on, its delivery outcome) has settled.
        socket.pause();
        processFrames(frames)
          .catch((error: unknown) => {
            ctx.logger.error('statsd: unhandled tcp processing error', {
              from: peer,
              error: errorMessage(error),
            });
          })
          .finally(() => {
            if (!shuttingDown && !socket.destroyed) socket.resume();
          });
      });

      socket.on('end', () => {
        const trailing = framer.finish();
        if (trailing.length > 0 && !shuttingDown) void processFrames(trailing);
      });

      socket.on('error', (error) => {
        ctx.logger.debug('statsd: tcp socket error', { from: peer, error: errorMessage(error) });
      });

      socket.on('close', () => {
        sockets.delete(socket);
      });
    });

    server.once('error', reject);
    server.listen(tcpOpts.address.port, tcpOpts.address.host, () => {
      server.removeListener('error', reject);
      const bound = server.address();
      const address: SocketAddress =
        bound !== null && typeof bound === 'object'
          ? { host: bound.address, port: bound.port }
          : tcpOpts.address;
      ctx.logger.info('statsd: tcp listening', { address });
      resolve({
        address,
        stop: async () => {
          shuttingDown = true;
          const closed = new Promise<void>((res) => server.once('close', res));
          server.close();
          for (const socket of sockets) socket.pause();
          await Promise.all(inFlight);
          for (const socket of sockets) socket.destroy();
          await closed;
        },
      });
    });
  });
}

export const statsdSource = defineSource<StatsdOptions>({
  kind: 'source',
  type: 'statsd',
  description: 'Receives StatsD/DogStatsD metrics over UDP and/or TCP.',
  options,
  produces: () => ['metric'],
  examples: [
    {
      title: 'Receive StatsD over UDP on the conventional port',
      config: { udp: { address: '0.0.0.0:8125' } },
    },
  ],
  build(opts, _buildCtx): StatsdSourceHandle {
    const decoder = defaultCodecs.createDecoder('statsd', opts.decoding);

    let udpBound: SocketAddress | undefined;
    let tcpBound: SocketAddress | undefined;

    async function run(ctx: SourceContext): Promise<void> {
      if (ctx.signal.aborted) return;

      const metrics: StatsdMetrics = {
        errors: ctx.metrics.counter(Metrics.errors),
        udpPacketsTotal: ctx.metrics.counter('statsd_udp_packets_total'),
        udpDroppedTotal: ctx.metrics.counter('statsd_udp_dropped_total'),
        tcpConnectionsTotal: ctx.metrics.counter('statsd_tcp_connections_total'),
        tcpConnectionsRejectedTotal: ctx.metrics.counter('statsd_tcp_connections_rejected_total'),
      };

      const listeners: Promise<void>[] = [];

      if (opts.udp !== undefined) {
        const { address, stop } = await startUdp(opts.udp, decoder, ctx, metrics);
        udpBound = address;
        listeners.push(waitThenStop(ctx, stop, () => (udpBound = undefined)));
      }
      if (opts.tcp !== undefined) {
        const { address, stop } = await startTcp(opts.tcp, decoder, ctx, metrics);
        tcpBound = address;
        listeners.push(waitThenStop(ctx, stop, () => (tcpBound = undefined)));
      }

      await Promise.all(listeners);
    }

    return {
      run,
      udpAddress: () => udpBound,
      tcpAddress: () => tcpBound,
    };
  },
});

/** Waits for shutdown to begin, then runs `stop`, then clears the listener's bound-address
 * accessor. Factored out so `run()` can start UDP and TCP listeners independently and let each
 * one's graceful shutdown proceed concurrently with the other's. */
async function waitThenStop(
  ctx: SourceContext,
  stop: () => Promise<void>,
  onStopped: () => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    if (ctx.signal.aborted) {
      resolve();
      return;
    }
    ctx.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    await stop();
  } finally {
    onStopped();
  }
}

export default statsdSource;
