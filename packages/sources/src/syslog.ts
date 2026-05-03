/**
 * `syslog`: receives syslog messages over TCP and/or UDP. Framing (RFC 6587 octet-counting with a
 * newline-delimited fallback) and message parsing (RFC 5424 / RFC 3164) are both owned by
 * `@ferrule/codecs` — this source only owns the socket plumbing: listening, per-connection
 * framing state, TLS, connection/packet limits, backpressure, and acknowledgement-aware
 * bookkeeping. A single instance may run a TCP listener, a UDP listener, or both concurrently.
 */
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { BatchNotifier, type LogEvent, type Timestamp } from '@ferrule/core';
import {
  decodeSyslog3164ToLogEvent,
  decodeSyslog5424ToLogEvent,
  decodeSyslogAuto,
  OctetCountingFramer,
} from '@ferrule/codecs';
import {
  defineSource,
  DEFAULT_PORT,
  Metrics,
  type BuildContext,
  type Source,
  type SourceContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { tlsSchema } from './fragments.js';
import { loadTlsServerOptions } from './util/http.js';

const tcpOptionsSchema = s.object({
  address: s
    .socketAddress(true)
    .default({ host: '0.0.0.0', port: 601 })
    .describe(
      'TCP address to listen on for syslog connections (RFC 6587 framing). Port 0 binds an ' +
        'OS-assigned ephemeral port.',
    )
    .example('0.0.0.0:601'),
  tls: tlsSchema,
  max_connections: s
    .integer({ min: 1 })
    .default(1024)
    .describe(
      'Maximum concurrent TCP connections. Additional connections are refused immediately.',
    ),
  max_frame_length: s
    .byteSize()
    .default(1024 * 1024)
    .describe(
      'Maximum length of one syslog message, whether framed by RFC 6587 octet-counting or by ' +
        'the newline-delimited fallback used when a stream does not start with an octet count.',
    ),
  idle_timeout: s
    .duration()
    .default(300_000)
    .describe('A connection that sends nothing for this long is closed, to bound resource usage.'),
});

const udpOptionsSchema = s.object({
  address: s
    .socketAddress(true)
    .default({ host: '0.0.0.0', port: 514 })
    .describe('UDP address to listen on for syslog datagrams, one message per datagram.')
    .example('0.0.0.0:514'),
  max_packet_size: s
    .byteSize()
    .default(64 * 1024)
    .describe(
      'Datagrams larger than this are dropped and counted rather than decoded, defensively — ' +
        'the OS/protocol already bounds a single datagram, but this keeps a misbehaving sender ' +
        'from forcing large allocations.',
    ),
  max_concurrent_sends: s
    .integer({ min: 1 })
    .default(256)
    .describe(
      'Bounds how many decoded datagrams may have an output.send awaiting acceptance at once. ' +
        'UDP sockets cannot be paused the way TCP sockets can, so once this many sends are ' +
        'outstanding, additional datagrams are dropped and counted instead of being queued ' +
        'without bound.',
    ),
});

const decodeErrorsSchema = s
  .object({
    log_level: s
      .enum(['debug', 'warn'])
      .default('debug')
      .describe('Log level used when a message fails to decode.'),
    snippet_size: s
      .byteSize({ min: 0 })
      .default(200)
      .describe(
        'Bytes of a malformed message included (truncated) in the log line, so large payloads ' +
          'are never logged in full — only enough to identify what a sender is doing wrong.',
      ),
  })
  .default({ log_level: 'debug', snippet_size: 200 })
  .describe(
    'A message that fails to decode is always counted (component_errors_total, ' +
      'component_discarded_events_total) and skipped rather than crashing its connection or the ' +
      'source; these fields only control how it is logged.',
  );

const options = s
  .object({
    tcp: tcpOptionsSchema
      .optional()
      .describe('Receive syslog messages over TCP. May be combined with `udp`.'),
    udp: udpOptionsSchema
      .optional()
      .describe('Receive syslog messages over UDP. May be combined with `tcp`.'),
    format: s
      .enum(['auto', 'rfc5424', 'rfc3164'])
      .default('auto')
      .describe(
        'Which syslog decoder to use. "auto" detects RFC 5424 vs RFC 3164 per message; pin it ' +
          'to skip detection when every sender uses the same format.',
      ),
    decode_errors: decodeErrorsSchema,
  })
  .refine(
    (v) => v.tcp !== undefined || v.udp !== undefined,
    'at least one of "tcp" or "udp" must be configured',
  );

export type SyslogOptions = Infer<typeof options>;
type TcpOptions = NonNullable<SyslogOptions['tcp']>;
type UdpOptions = NonNullable<SyslogOptions['udp']>;

/** Handle returned by {@link syslogSource}'s `build`, beyond the fixed `Source` contract: the
 * addresses each configured listener actually bound to, for tests that listen on port 0. */
export interface SyslogSourceHandle extends Source {
  tcpAddress(): { host: string; port: number } | undefined;
  udpAddress(): { host: string; port: number } | undefined;
}

interface BoundAddress {
  host: string;
  port: number;
}

export const syslogSource = defineSource<SyslogOptions>({
  kind: 'source',
  type: 'syslog',
  description: 'Receives syslog messages (RFC 5424 / RFC 3164) over TCP and/or UDP.',
  options,
  produces: () => ['log'],
  examples: [
    {
      title: 'Receive syslog over TCP (RFC 6587 framing) and UDP',
      config: {
        tcp: { address: '0.0.0.0:601' },
        udp: { address: '0.0.0.0:514' },
      },
    },
    {
      title: 'Receive syslog over TLS, pinning RFC 5424',
      config: {
        tcp: {
          address: '0.0.0.0:6514',
          tls: { cert_file: '/etc/ferrule/cert.pem', key_file: '/etc/ferrule/key.pem' },
        },
        format: 'rfc5424',
      },
    },
  ],
  build(opts, _buildCtx: BuildContext): SyslogSourceHandle {
    let tcpBoundAddress: BoundAddress | undefined;
    let udpBoundAddress: BoundAddress | undefined;

    function decodeOne(bytes: Uint8Array, now: Timestamp): LogEvent {
      switch (opts.format) {
        case 'rfc5424':
          return decodeSyslog5424ToLogEvent(bytes);
        case 'rfc3164':
          return decodeSyslog3164ToLogEvent(bytes, { now });
        case 'auto':
          return decodeSyslogAuto(bytes, { now });
      }
    }

    async function run(ctx: SourceContext): Promise<void> {
      if (ctx.signal.aborted) return;

      const errorsCounter = ctx.metrics.counter(Metrics.errors);
      const discardedCounter = ctx.metrics.counter(Metrics.discardedEvents);

      function snippet(bytes: Uint8Array): string {
        const max = opts.decode_errors.snippet_size;
        const slice = bytes.length > max ? bytes.subarray(0, max) : bytes;
        const text = Buffer.from(slice).toString('utf8');
        return bytes.length > max ? `${text}…` : text;
      }

      function logDecodeError(
        error: unknown,
        bytes: Uint8Array,
        fields: Record<string, unknown>,
      ): void {
        errorsCounter.increment();
        discardedCounter.increment();
        const logFields = {
          ...fields,
          error: error instanceof Error ? error.message : String(error),
          snippet: snippet(bytes),
        };
        if (opts.decode_errors.log_level === 'warn') {
          ctx.logger.warn('syslog: discarding a message that failed to decode', logFields);
        } else {
          ctx.logger.debug('syslog: discarding a message that failed to decode', logFields);
        }
      }

      function applyPeerMetadata(
        event: LogEvent,
        addr: string | undefined,
        port: number | undefined,
      ): void {
        if (addr !== undefined) event.set('syslog.peer_addr', addr);
        if (port !== undefined) event.set('syslog.peer_port', BigInt(port));
      }

      async function runTcp(tcpOpts: TcpOptions): Promise<void> {
        const connectionsTotal = ctx.metrics.counter('syslog_tcp_connections_total');
        const connectionsRejected = ctx.metrics.counter('syslog_tcp_connections_rejected_total');
        const connectionsActive = ctx.metrics.gauge('syslog_tcp_connections_active');
        const framingErrors = ctx.metrics.counter('syslog_tcp_framing_errors_total');

        interface ConnState {
          readonly socket: NetSocket;
          pending: boolean;
        }
        const connections = new Set<ConnState>();
        let activeConnections = 0;
        let shuttingDown = false;

        function handleConnection(socket: NetSocket): void {
          if (activeConnections >= tcpOpts.max_connections) {
            connectionsRejected.increment();
            ctx.logger.warn('syslog: tcp connection limit reached, rejecting new connection', {
              max_connections: tcpOpts.max_connections,
            });
            socket.destroy();
            return;
          }
          activeConnections++;
          connectionsTotal.increment();
          connectionsActive.set(activeConnections);
          const state: ConnState = { socket, pending: false };
          connections.add(state);
          const peerAddr = socket.remoteAddress;
          const peerPort = socket.remotePort;
          const framer = new OctetCountingFramer({ maxFrameLength: tcpOpts.max_frame_length });

          if (tcpOpts.idle_timeout > 0) socket.setTimeout(tcpOpts.idle_timeout);

          socket.on('timeout', () => {
            ctx.logger.debug('syslog: tcp connection idle timeout, closing', {
              peerAddr,
              peerPort,
            });
            socket.destroy();
          });
          socket.on('error', (error) => {
            ctx.logger.debug('syslog: tcp connection error', {
              peerAddr,
              peerPort,
              error: error.message,
            });
          });
          socket.once('close', () => {
            connections.delete(state);
            activeConnections--;
            connectionsActive.set(activeConnections);
          });

          async function processFrames(frames: Uint8Array[]): Promise<void> {
            const now = ctx.clock.now();
            const events: LogEvent[] = [];
            for (const frame of frames) {
              try {
                const event = decodeOne(frame, now);
                applyPeerMetadata(event, peerAddr, peerPort);
                events.push(event);
              } catch (error) {
                logDecodeError(error, frame, { transport: 'tcp', peerAddr, peerPort });
              }
            }
            if (events.length === 0) return;

            const batch = new BatchNotifier();
            for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
            batch.seal();

            // Backpressure: pause reading this socket while the batch is being accepted (and, if
            // acknowledgements are on, until delivery is confirmed) so a slow downstream throttles
            // the TCP receive window instead of buffering unboundedly in this process.
            state.pending = true;
            socket.pause();
            try {
              await ctx.output.send(events, DEFAULT_PORT);
              if (ctx.acknowledgements) {
                const status = await batch.completion;
                if (status !== 'delivered') {
                  errorsCounter.increment();
                  ctx.logger.warn('syslog: tcp batch was not delivered', {
                    status,
                    peerAddr,
                    peerPort,
                  });
                }
              }
            } catch (error) {
              errorsCounter.increment();
              ctx.logger.warn('syslog: tcp send failed', {
                peerAddr,
                peerPort,
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              state.pending = false;
              // Once shutdown has begun, this connection has finished the message it was
              // mid-processing (the whole point of `pending`); do not resume reading further
              // messages from it — close it instead, per the "stop accepting new work" contract.
              if (shuttingDown) socket.destroy();
              else socket.resume();
            }
          }

          socket.on('data', (chunk: Buffer) => {
            if (shuttingDown) {
              socket.destroy();
              return;
            }
            let frames: Uint8Array[];
            try {
              frames = framer.push(chunk);
            } catch (error) {
              framingErrors.increment();
              ctx.logger.warn('syslog: tcp framing error, closing connection', {
                peerAddr,
                peerPort,
                error: error instanceof Error ? error.message : String(error),
              });
              socket.destroy();
              return;
            }
            if (frames.length === 0) return;
            processFrames(frames).catch((error: unknown) => {
              ctx.logger.error('syslog: unhandled tcp processing error', {
                peerAddr,
                peerPort,
                error: String(error),
              });
              socket.destroy();
            });
          });
        }

        let server: NetServer;
        if (tcpOpts.tls === undefined) {
          const plain = createNetServer();
          plain.on('connection', handleConnection);
          server = plain;
        } else {
          const secure = createTlsServer(await loadTlsServerOptions(tcpOpts.tls));
          secure.on('secureConnection', handleConnection);
          server = secure;
        }
        server.on('error', (error) => {
          ctx.logger.error('syslog: tcp server error', { error: error.message });
        });

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(tcpOpts.address.port, tcpOpts.address.host, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        const listening = server.address();
        tcpBoundAddress =
          listening !== null && typeof listening === 'object'
            ? { host: listening.address, port: listening.port }
            : tcpOpts.address;
        ctx.logger.info('syslog: tcp listening', { address: tcpBoundAddress });

        const stopped = new Promise<void>((resolve) => server.once('close', resolve));
        const onAbort = (): void => {
          shuttingDown = true;
          server.close();
          for (const state of connections) if (!state.pending) state.socket.destroy();
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await stopped;
        } finally {
          ctx.signal.removeEventListener('abort', onAbort);
          tcpBoundAddress = undefined;
        }
      }

      async function runUdp(udpOpts: UdpOptions): Promise<void> {
        const packetsTotal = ctx.metrics.counter('syslog_udp_packets_total');
        const packetsOversize = ctx.metrics.counter('syslog_udp_packets_oversize_total');
        const packetsDropped = ctx.metrics.counter('syslog_udp_packets_dropped_total');

        let acceptingNew = true;
        let inFlight = 0;
        let drainWaiters: (() => void)[] = [];

        function notifyDrain(): void {
          if (inFlight === 0) {
            const waiters = drainWaiters;
            drainWaiters = [];
            for (const wait of waiters) wait();
          }
        }

        async function handleDatagram(msg: Buffer, rinfo: RemoteInfo): Promise<void> {
          const now = ctx.clock.now();
          let event: LogEvent;
          try {
            event = decodeOne(msg, now);
          } catch (error) {
            logDecodeError(error, msg, {
              transport: 'udp',
              peerAddr: rinfo.address,
              peerPort: rinfo.port,
            });
            return;
          }
          applyPeerMetadata(event, rinfo.address, rinfo.port);

          const batch = new BatchNotifier();
          event.metadata.finalizers.add(batch.createFinalizer());
          batch.seal();
          try {
            await ctx.output.send(event, DEFAULT_PORT);
          } catch (error) {
            errorsCounter.increment();
            ctx.logger.warn('syslog: udp send failed', {
              peerAddr: rinfo.address,
              peerPort: rinfo.port,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          if (ctx.acknowledgements) {
            const status = await batch.completion;
            if (status !== 'delivered') {
              errorsCounter.increment();
              ctx.logger.warn('syslog: udp datagram was not delivered', {
                status,
                peerAddr: rinfo.address,
                peerPort: rinfo.port,
              });
            }
          }
        }

        const socket: DgramSocket = createSocket(
          udpOpts.address.host.includes(':') ? 'udp6' : 'udp4',
        );

        // Backpressure: `dgram` sockets have no pause/resume flow control (a datagram either
        // arrives or the OS drops it before we ever see it), so instead we bound the number of
        // `output.send` calls in flight at once. Beyond that bound, additional datagrams are
        // dropped and counted rather than queued — an unbounded backlog of pending promises would
        // just move the OS's drop decision into this process's memory instead of avoiding it.
        socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
          packetsTotal.increment();
          if (msg.length > udpOpts.max_packet_size) {
            packetsOversize.increment();
            ctx.logger.warn('syslog: udp datagram exceeds max_packet_size, dropping', {
              length: msg.length,
              max: udpOpts.max_packet_size,
              peerAddr: rinfo.address,
              peerPort: rinfo.port,
            });
            return;
          }
          if (!acceptingNew) {
            packetsDropped.increment();
            return;
          }
          if (inFlight >= udpOpts.max_concurrent_sends) {
            packetsDropped.increment();
            ctx.logger.debug('syslog: udp backpressure limit reached, dropping datagram', {
              max_concurrent_sends: udpOpts.max_concurrent_sends,
            });
            return;
          }
          inFlight++;
          handleDatagram(msg, rinfo)
            .catch((error: unknown) => {
              ctx.logger.error('syslog: unhandled udp processing error', { error: String(error) });
            })
            .finally(() => {
              inFlight--;
              notifyDrain();
            });
        });
        socket.on('error', (error) => {
          ctx.logger.warn('syslog: udp socket error', { error: error.message });
        });

        await new Promise<void>((resolve, reject) => {
          socket.once('error', reject);
          socket.bind(udpOpts.address.port, udpOpts.address.host, () => {
            socket.removeListener('error', reject);
            resolve();
          });
        });
        const addr = socket.address();
        udpBoundAddress = { host: addr.address, port: addr.port };
        ctx.logger.info('syslog: udp listening', { address: udpBoundAddress });

        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });

        // Stop accepting new datagrams, let any already-in-flight `output.send` calls finish,
        // and only then close the socket — closing earlier would abandon in-flight work.
        acceptingNew = false;
        if (inFlight > 0) await new Promise<void>((resolve) => drainWaiters.push(resolve));
        await new Promise<void>((resolve) => socket.close(() => resolve()));
        udpBoundAddress = undefined;
      }

      const tasks: Promise<void>[] = [];
      if (opts.tcp !== undefined) tasks.push(runTcp(opts.tcp));
      if (opts.udp !== undefined) tasks.push(runUdp(opts.udp));
      await Promise.all(tasks);
    }

    return {
      run,
      tcpAddress: () => tcpBoundAddress,
      udpAddress: () => udpBoundAddress,
    };
  },
});

export default syslogSource;
