import { defineSink, type Sink, type SinkContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

export const blackholeSinkOptionsSchema = s.object({
  /** If set, logs a running event/byte count at this interval. Default: never logs. */
  logInterval: s.duration().optional(),
});

export type BlackholeSinkOptions = Infer<typeof blackholeSinkOptionsSchema>;

/**
 * Discards every event it receives, finishing each as `delivered` immediately. Useful for
 * benchmarking the rest of a pipeline (sources, transforms, buffering) without a real
 * destination's I/O cost in the measurement.
 */
export function createBlackholeSink(options: BlackholeSinkOptions): Sink {
  return {
    async run(ctx: SinkContext): Promise<void> {
      let totalEvents = 0;
      let totalBytes = 0;
      const stopLogging = new AbortController();
      const logging =
        options.logInterval !== undefined
          ? logProgress(ctx, options.logInterval, () => totalEvents, stopLogging.signal)
          : undefined;
      try {
        for await (const batch of ctx.input) {
          for (const event of batch) {
            totalEvents++;
            totalBytes += event.estimatedSize();
            event.metadata.finalizers.finish('delivered');
          }
        }
      } finally {
        stopLogging.abort();
        await logging;
      }
      ctx.logger.info('blackhole sink stopped', { totalEvents, totalBytes });
    },
  };
}

async function logProgress(
  ctx: SinkContext,
  intervalMs: number,
  getCount: () => number,
  signal: AbortSignal,
): Promise<void> {
  let last = 0;
  for (;;) {
    try {
      await ctx.clock.sleep(intervalMs, signal);
    } catch {
      return;
    }
    const count = getCount();
    ctx.logger.info('blackhole sink progress', { totalEvents: count, sinceLast: count - last });
    last = count;
  }
}

export const blackholeSink = defineSink({
  kind: 'sink',
  type: 'blackhole',
  description: 'Discards every event; useful for benchmarking the rest of a pipeline.',
  options: blackholeSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [{ title: 'Log throughput every 10s', config: { logInterval: '10s' } }],
  build: (options: BlackholeSinkOptions) => createBlackholeSink(options),
});
