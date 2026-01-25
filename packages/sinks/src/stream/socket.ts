import { concatBytes, type Event } from '@ferrule/core';
import { defaultCodecs, type CodecRegistry } from '@ferrule/codecs';
import {
  defineSink,
  runBatchedSink,
  RetryPolicy,
  type BuildContext,
  type Logger,
  type Sink,
  type SinkContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { writeWithBackpressure } from './backpressure-write.js';
import { frameBytes, type FramingMode } from './frame-writer.js';
import { TcpTransport, UdpTransport, tlsOptionsSchema, type Transport } from './wire-transport.js';

export const socketSinkOptionsSchema = s.object({
  protocol: s.enum(['tcp', 'udp']),
  host: s.string().nonEmpty(),
  port: s.integer({ min: 1, max: 65535 }),
  encoding: s.string().default('json'),
  encodingOptions: s.unknown().optional(),
  /** How events are separated on the wire. TCP only; UDP sends one datagram per event. */
  framing: s.enum(['newline', 'length_prefixed', 'octet_counting']).default('newline'),
  lengthPrefixWidth: s.enum(['u16', 'u32']).default('u32'),
  lengthPrefixEndianness: s.enum(['BE', 'LE']).default('BE'),
  /** TCP only: batches up to this many events into one write. Default 500. */
  batchMaxEvents: s.integer({ min: 1 }).default(500),
  /** TCP only: batches up to this many estimated bytes into one write. Default 1MiB. */
  batchMaxBytes: s.byteSize().default(1024 * 1024),
  /** TCP only: flushes a partial batch after this long. Default 1s. */
  batchTimeout: s.duration().default(1_000),
  /** UDP only: a datagram larger than this is rejected rather than sent. Default 65507 (the
   * maximum IPv4 UDP payload). */
  maxDatagramBytes: s.byteSize().default(65_507),
  tls: tlsOptionsSchema.optional(),
  /** How long a TCP connection attempt may take before it is treated as a failure. Default 10s. */
  connectTimeout: s.duration().default(10_000),
  /** Reconnect/retry backoff for TCP connection and write failures. */
  retryInitialDelay: s.duration().default(250),
  retryMaxDelay: s.duration().default(30_000),
});

export type SocketSinkOptions = Infer<typeof socketSinkOptionsSchema>;

function framingModeOf(options: SocketSinkOptions): FramingMode {
  if (options.framing === 'length_prefixed') {
    return {
      kind: 'length_prefixed',
      width: options.lengthPrefixWidth,
      endianness: options.lengthPrefixEndianness,
    };
  }
  if (options.framing === 'octet_counting') return { kind: 'octet_counting' };
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
        if (bytes.length > options.maxDatagramBytes) {
          logger.warn('socket sink rejected an oversize UDP datagram', {
            size: bytes.length,
            maxDatagramBytes: options.maxDatagramBytes,
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
  const encoder = codecs.createEncoder(options.encoding, options.encodingOptions);
  const framing = framingModeOf(options);
  return {
    async run(ctx: SinkContext): Promise<void> {
      const transport = makeTransport(options, ctx.logger);
      const encodeBatch = makeEncodeBatch(options, encoder, framing, ctx.logger);
      const isUdp = options.protocol === 'udp';
      try {
        await runBatchedSink(ctx, {
          maxEvents: isUdp ? 1 : options.batchMaxEvents,
          ...(isUdp ? {} : { maxBytes: options.batchMaxBytes, timeoutMs: options.batchTimeout }),
          encode: encodeBatch,
          send: (payload) => transport.send(payload, ctx.signal),
          retry: new RetryPolicy({
            initialDelayMs: options.retryInitialDelay,
            maxDelayMs: options.retryMaxDelay,
          }),
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
