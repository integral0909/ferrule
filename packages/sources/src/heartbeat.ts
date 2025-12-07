/**
 * `heartbeat`: emits one log event per interval, carrying the host's identity and uptime. Handy
 * as a liveness signal for a pipeline itself (wire it to a sink and alert if the events stop
 * arriving) and as the simplest possible source for smoke-testing a new pipeline configuration.
 */
import { hostname } from 'node:os';
import { BatchNotifier, LogEvent } from '@ferrule/core';
import { defineSource, type SourceContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

const options = s.object({
  intervalMs: s.duration().default(10_000).describe('How often to emit a heartbeat event.'),
  message: s.string().default('heartbeat').describe("Text carried in the event's `message` field."),
});

export type HeartbeatOptions = Infer<typeof options>;

export const heartbeatSource = defineSource<HeartbeatOptions>({
  kind: 'source',
  type: 'heartbeat',
  description: "Emits one log event per interval with this host's identity and uptime.",
  options,
  produces: () => ['log'],
  examples: [
    {
      title: 'A heartbeat every 30 seconds',
      config: { intervalMs: '30s', message: 'still alive' },
    },
  ],
  build(opts) {
    return {
      async run(ctx: SourceContext): Promise<void> {
        if (ctx.signal.aborted) return;
        const emitted = ctx.metrics.counter('heartbeat_events_total');

        while (!ctx.signal.aborted) {
          try {
            // Not tied to a timeout race, so `ctx.signal` is the right abort source here: a
            // heartbeat has no in-flight work to protect, unlike the backpressure races in
            // http_server.ts.
            await ctx.clock.sleep(opts.intervalMs, ctx.signal);
          } catch {
            return;
          }
          if (ctx.signal.aborted) return;

          const event = LogEvent.from({
            message: opts.message,
            hostname: hostname(),
            uptime_seconds: process.uptime(),
            timestamp: ctx.clock.now(),
          });
          const batch = new BatchNotifier();
          event.metadata.finalizers.add(batch.createFinalizer());
          batch.seal();

          await ctx.output.send(event);
          emitted.increment();
          if (ctx.acknowledgements) {
            const status = await batch.completion;
            if (status !== 'delivered') {
              ctx.logger.warn('heartbeat: event not delivered', { status });
            }
          }
        }
      },
    };
  },
});

export default heartbeatSource;
