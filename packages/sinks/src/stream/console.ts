import { FerruleError } from '@ferrule/core';
import { defaultCodecs, type CodecRegistry } from '@ferrule/codecs';
import {
  defineSink,
  Metrics,
  type BuildContext,
  type Sink,
  type SinkContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { writeWithBackpressure } from './backpressure-write.js';
import { frameBytes, type FramingMode } from './frame-writer.js';

export const consoleSinkOptionsSchema = s.object({
  /** Which process stream to write to. Default `stdout`. */
  stream: s.enum(['stdout', 'stderr']).default('stdout'),
  /** Codec used to encode each event. Default `json`. */
  encoding: s.string().default('json'),
  /** Options passed through to the codec's encoder. */
  encodingOptions: s.unknown().optional(),
  /** How successive encoded events are separated. Default `newline`. */
  framing: s.enum(['newline', 'length_prefixed', 'octet_counting']).default('newline'),
  /** Width of the length prefix when `framing` is `length_prefixed`. Default `u32`. */
  lengthPrefixWidth: s.enum(['u16', 'u32']).default('u32'),
  /** Byte order of the length prefix when `framing` is `length_prefixed`. Default `BE`. */
  lengthPrefixEndianness: s.enum(['BE', 'LE']).default('BE'),
});

export type ConsoleSinkOptions = Infer<typeof consoleSinkOptionsSchema>;

function framingModeOf(options: ConsoleSinkOptions): FramingMode {
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

/**
 * The reusable core of the `console` sink: encodes each event with a codec, frames it, and writes
 * it to `target`, respecting the stream's backpressure (waiting for `'drain'` when `write()`
 * reports a full buffer). Exposed directly (not just through the `SinkDefinition`) so tests can
 * inject an in-memory `Writable` instead of `process.stdout`/`process.stderr`.
 */
export function createConsoleSink(
  options: ConsoleSinkOptions,
  target: NodeJS.WritableStream,
  codecs: CodecRegistry = defaultCodecs,
): Sink {
  const encoder = codecs.createEncoder(options.encoding, options.encodingOptions);
  const framing = framingModeOf(options);
  return {
    async run(ctx: SinkContext): Promise<void> {
      for await (const batch of ctx.input) {
        for (const event of batch) {
          try {
            const encoded = encoder.encode(event);
            const framed = frameBytes(framing, encoded);
            await writeWithBackpressure(target, framed, ctx.signal);
            event.metadata.finalizers.finish('delivered');
          } catch (error) {
            ctx.logger.error('console sink failed to write event', { error: describeError(error) });
            event.metadata.finalizers.finish('errored');
            ctx.metrics.counter(Metrics.errors).increment();
          }
        }
      }
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof FerruleError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export const consoleSink = defineSink({
  kind: 'sink',
  type: 'console',
  description: 'Writes events to stdout or stderr, one framed, encoded payload per event.',
  options: consoleSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [
    { title: 'NDJSON to stdout', config: { encoding: 'json', framing: 'newline' } },
    { title: 'Plain text to stderr', config: { stream: 'stderr', encoding: 'text' } },
  ],
  build: (options: ConsoleSinkOptions, _ctx: BuildContext) =>
    createConsoleSink(options, options.stream === 'stderr' ? process.stderr : process.stdout),
});
