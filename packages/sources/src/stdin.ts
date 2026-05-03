/**
 * `stdin`: reads newline-framed records from the process's standard input, decodes each with a
 * configurable codec (reusing `@ferrule/codecs`'s registry and `NewlineFramer`, the same framing
 * building block `http_server.ts` uses for line-oriented bodies), and ends cleanly on EOF —
 * handy for `cat access.log | ferrule run ...`-style one-off ingestion and for local testing.
 *
 * The stream read from is injectable (`createStdinSource(stream)`) so it can be swapped for a
 * fake readable in tests; `stdinSource` is the default instance wired to the real
 * `process.stdin`.
 */
import { BatchNotifier, type EventKind } from '@ferrule/core';
import { decodeFrames, defaultCodecs, NewlineFramer, type CodecRegistry } from '@ferrule/codecs';
import { defineSource, Metrics, type SourceContext, type SourceDefinition } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { decodingSchema, splitCodecOptions } from './fragments.js';

const options = s.object({
  decoding: decodingSchema('ndjson'),
  max_line_length: s
    .byteSize()
    .default(1024 * 1024)
    .describe('Maximum length of one line read from stdin.'),
});

export type StdinOptions = Infer<typeof options>;

function producesForCodec(name: string): readonly EventKind[] {
  switch (name) {
    case 'prometheus_text':
    case 'statsd':
      return ['metric'];
    case 'otlp_protobuf':
    case 'otlp_json':
      return ['log', 'metric', 'span'];
    default:
      return ['log'];
  }
}

/** Feature-detects a `.destroy()` method beyond the minimal `NodeJS.ReadableStream` interface.
 * Every stream this source is realistically pointed at (`process.stdin`, a `Readable`, a
 * `PassThrough`) has one; without it, shutdown simply waits for the stream to end on its own. */
function destroyable(stream: NodeJS.ReadableStream): { destroy(): void } | undefined {
  const candidate = stream as Partial<{ destroy: () => void }>;
  return typeof candidate.destroy === 'function'
    ? (candidate as { destroy: () => void })
    : undefined;
}

/** Builds a `stdin` source definition reading from `stdin` instead of the real `process.stdin` —
 * the seam tests use to feed it a fake readable. */
export function createStdinSource(
  stdin: NodeJS.ReadableStream = process.stdin,
): SourceDefinition<StdinOptions> {
  return defineSource<StdinOptions>({
    kind: 'source',
    type: 'stdin',
    description: 'Reads newline-framed, codec-decoded records from standard input.',
    options,
    produces: (opts) => producesForCodec(opts.decoding.codec),
    examples: [
      {
        title: 'Pipe NDJSON logs from a file into Ferrule',
        config: { decoding: { codec: 'ndjson' } },
      },
    ],
    build(opts) {
      return {
        async run(ctx: SourceContext): Promise<void> {
          if (ctx.signal.aborted) return;
          const codecs: CodecRegistry = defaultCodecs;
          const [decodingCodec, decodingOptions] = splitCodecOptions(opts.decoding);
          const decoder = codecs.createDecoder(decodingCodec, decodingOptions);
          const framer = new NewlineFramer({
            maxLineLength: opts.max_line_length,
            onOversize: 'error',
          });
          const decodeErrors = ctx.metrics.counter(Metrics.errors);
          const linesDecoded = ctx.metrics.counter('stdin_lines_decoded_total');

          async function processFrame(frame: Uint8Array): Promise<void> {
            if (frame.length === 0) return;
            const { events, errors } = decodeFrames(decoder, [frame]);
            for (const failure of errors) {
              decodeErrors.increment();
              ctx.logger.warn('stdin: failed to decode line; skipping it', {
                error: failure.error.message,
              });
            }
            if (events.length === 0) return;
            linesDecoded.increment();
            const batch = new BatchNotifier();
            for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
            batch.seal();
            await ctx.output.send(events);
            if (ctx.acknowledgements) {
              const status = await batch.completion;
              if (status !== 'delivered') {
                ctx.logger.warn('stdin: batch not delivered', { status });
              }
            }
          }

          // On shutdown, destroy the stream directly rather than calling the async iterator's
          // own `return()`: `return()` deadlocks while a `next()` read is still outstanding (as
          // it always is while this loop is idle, waiting for the next line), whereas destroying
          // the stream makes that pending read settle immediately — with `done: true` if the
          // stream was already at EOF, or by rejecting (typically "Premature close"), which the
          // catch below recognises as a shutdown it caused rather than a genuine stream error.
          const stream = destroyable(stdin);
          const onAbort = (): void => stream?.destroy();
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });

          try {
            try {
              for await (const chunk of stdin) {
                const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
                let frames: Uint8Array[];
                try {
                  frames = framer.push(bytes);
                } catch (error) {
                  ctx.logger.warn('stdin: line exceeded maxLineLength; discarding it', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                  framer.reset();
                  continue;
                }
                for (const frame of frames) await processFrame(frame);
              }
            } catch (error) {
              if (!ctx.signal.aborted) throw error; // a genuine stream error, not our own doing
            }
            if (!ctx.signal.aborted) {
              // EOF: flush a final line that had no trailing newline. On an abort instead, any
              // still-buffered, not-yet-terminated bytes are genuinely incomplete input rather
              // than in-flight work, so they are dropped rather than emitted as a truncated line.
              for (const frame of framer.finish()) await processFrame(frame);
            }
          } finally {
            ctx.signal.removeEventListener('abort', onAbort);
          }
        },
      };
    },
  });
}

export const stdinSource: SourceDefinition<StdinOptions> = createStdinSource();

export default stdinSource;
