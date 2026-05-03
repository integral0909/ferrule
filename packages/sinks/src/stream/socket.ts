import { concatBytes, type Event } from '@ferrule/core';
import { defaultCodecs, type CodecRegistry } from '@ferrule/codecs';
import {
  defineSink,
  runBatchedSink,
  type BuildContext,
  type Logger,
  type Sink,
  type SinkContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import {
  batchSchema,
  buildRetryPolicy,
  encodingSchema,
  framingSchema,
  retrySchema,
  splitCodecOptions,
  tlsSchema,
} from '../fragments.js';
import { writeWithBackpressure } from './backpressure-write.js';
import { frameBytes, type FramingMode } from './frame-writer.js';
import { TcpTransport, UdpTransport, type Transport } from './wire-transport.js';

export const socketSinkOptionsSchema = s.object({
  protocol: s.enum(['tcp', 'udp']),
  host: s.string().nonEmpty(),
  port: s.integer({ min: 1, max: 65535 }),
  /** Codec used to encode each event. Default `json`. */
  encoding: encodingSchema('json'),
  /** How events are separated on the wire. TCP only; UDP sends one datagram per event. */
  framing: framingSchema,
  /** TCP only: groups events into batches before writing them. Default: 500 events / 1MiB / 1s. */
  batch: batchSchema,
  /** UDP only: a datagram larger than this is rejected rather than sent. Default 65507 (the
   * maximum IPv4 UDP payload). */
  max_datagram_size: s.byteSize().default(65_507),
  tls: tlsSchema,
  /** How long a TCP connection attempt may take before it is treated as a failure. Default 10s. */
  connect_timeout: s.duration().default(10_000),
  /** Reconnect/retry backoff for TCP connection and write failures. Default 250ms/30s. */
  retry: retrySchema,
});

export type SocketSinkOptions = Infer<typeof socketSinkOptionsSchema>;

function framingModeOf(options: SocketSinkOptions): FramingMode {
  const framing = options.framing;
  if (framing.method === 'length_prefixed') {
    return { kind: 'length_prefixed', width: framing.width, endianness: framing.endianness };
  }
  if (framing.method === 'octet_counting') return { kind: 'octet_counting' };
  return { kind: 'newline' };
}

function makeTransport(options: SocketSinkOptions, logger: Logger): Transport {
  return options.protocol === 'udp'
    ? new UdpTransport(options)
    : new TcpTransport(options, logger, writeWithBackpressure);
}

/**
 * Encodes and (for TCP) frames a batch of events into one payload, finishing any event that
 * fails to encode or (for UDP) exceeds the datagram size limit as `rejected` immediately and
 * excluding it from the payload. Must never throw: {@link runBatchedSink} does not guard its
 * `encode` callback, so a throw here would leave the batch's finalizers unfinished.
 */
function makeEncodeBatch(
  options: SocketSinkOptions,
  encoder: { encode(event: Event): Uint8Array },
  framing: FramingMode,
  logger: Logger,
): (events: Event[]) => Uint8Array {
  return (events: Event[]): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (const event of events) {
      let bytes: Uint8Array;
      try {
        bytes = encoder.encode(event);
      } catch (error) {
        logger.warn('socket sink failed to encode an event', {
          error: error instanceof Error ? error.message : String(error),
        });
        event.metadata.finalizers.finish('rejected');
        continue;
      }
      if (options.protocol === 'udp') {
        if (bytes.length > options.max_datagram_size) {
          logger.warn('socket sink rejected an oversize UDP datagram', {
            size: bytes.length,
            max_datagram_size: options.max_datagram_size,
          });
          event.metadata.finalizers.finish('rejected');
          continue;
        }
        parts.push(bytes);
      } else {
        parts.push(frameBytes(framing, bytes));
      }
    }
    return concatBytes(parts);
  };
}

export function createSocketSink(
  options: SocketSinkOptions,
  codecs: CodecRegistry = defaultCodecs,
): Sink {
  const [codec, codecOptions] = splitCodecOptions(options.encoding);
  const encoder = codecs.createEncoder(codec, codecOptions);
  const framing = framingModeOf(options);
  return {
    async run(ctx: SinkContext): Promise<void> {
      const transport = makeTransport(options, ctx.logger);
      const encodeBatch = makeEncodeBatch(options, encoder, framing, ctx.logger);
      const isUdp = options.protocol === 'udp';
      try {
        await runBatchedSink(ctx, {
          maxEvents: isUdp ? 1 : (options.batch?.max_events ?? 500),
          ...(isUdp
            ? {}
            : {
                maxBytes: options.batch?.max_size ?? 1024 * 1024,
                timeoutMs: options.batch?.timeout ?? 1_000,
              }),
          encode: encodeBatch,
          send: (payload) => transport.send(payload, ctx.signal),
          retry: buildRetryPolicy(options.retry ?? { initial_backoff: 250, max_backoff: 30_000 }),
        });
      } finally {
        await transport.close();
      }
    },
    async healthcheck(ctx): Promise<void> {
      const probe = makeTransport(options, ctx.logger);
      try {
        await probe.probe();
      } finally {
        await probe.close();
      }
    },
  };
}

export const socketSink = defineSink({
  kind: 'sink',
  type: 'socket',
  description: 'Writes events to a TCP or UDP socket, with reconnect/backoff and optional TLS.',
  options: socketSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [
    { title: 'NDJSON over TCP', config: { protocol: 'tcp', host: '127.0.0.1', port: 9000 } },
    { title: 'JSON over UDP', config: { protocol: 'udp', host: '127.0.0.1', port: 9001 } },
  ],
  build: (options: SocketSinkOptions, _ctx: BuildContext) => createSocketSink(options),
});
