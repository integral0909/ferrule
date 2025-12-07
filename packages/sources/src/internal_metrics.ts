/**
 * `internal_metrics`: periodically publishes Ferrule's own recorded metrics (component event
 * counts, request durations, and anything else recorded through `ctx.metrics` across the running
 * pipeline) as `MetricEvent`s, via `ctx.metrics.snapshot()`. This is how a pipeline observes
 * itself — point this source at a sink to feed Ferrule's own telemetry into the same backend as
 * everything else it collects.
 *
 * `ctx.metrics.snapshot` is optional on the `MetricsRecorder` interface (some lightweight test
 * contexts do not implement it), but the real `MetricsRegistry` used by a running pipeline
 * always does. Since `build()` only receives a `BuildContext` (no `ctx.metrics` there to check
 * up front), this source instead fails fast at the very start of `run()`, before starting its
 * interval loop, if `snapshot` is unavailable — so a misconfigured or unsupported context fails
 * clearly rather than silently doing nothing forever.
 */
import { BatchNotifier, FerruleError, type MetricEvent } from '@ferrule/core';
import { defineSource, type SourceContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

const options = s.object({
  intervalMs: s
    .duration()
    .default(10_000)
    .describe('How often the current metrics snapshot is published.'),
  namespaceOverride: s
    .string()
    .optional()
    .describe(
      'When set, every emitted MetricEvent has its `series.namespace` field replaced with ' +
        'this value (regardless of what it was before), tagging the whole snapshot as coming ' +
        'from this pipeline. The metric name itself is left untouched. Unset by default, which ' +
        'leaves the namespace of each metric exactly as recorded.',
    ),
});

export type InternalMetricsOptions = Infer<typeof options>;

function applyNamespaceOverride(event: MetricEvent, namespace: string): MetricEvent {
  event.series.namespace = namespace;
  return event;
}

export const internalMetricsSource = defineSource<InternalMetricsOptions>({
  kind: 'source',
  type: 'internal_metrics',
  description: "Periodically publishes Ferrule's own recorded metrics as MetricEvents.",
  options,
  produces: () => ['metric'],
  examples: [
    {
      title: 'Publish internal metrics every 15 seconds under a fixed namespace',
      config: { intervalMs: '15s', namespaceOverride: 'ferrule' },
    },
  ],
  build(opts) {
    return {
      async run(ctx: SourceContext): Promise<void> {
        if (typeof ctx.metrics.snapshot !== 'function') {
          throw new FerruleError(
            'E_METRICS_SNAPSHOT_UNAVAILABLE',
            'internal_metrics requires a MetricsRecorder whose snapshot() is implemented; the ' +
              'provided context does not support it',
          );
        }
        if (ctx.signal.aborted) return;

        while (!ctx.signal.aborted) {
          try {
            await ctx.clock.sleep(opts.intervalMs, ctx.signal);
          } catch {
            return;
          }
          if (ctx.signal.aborted) return;

          // Called (not detached into a local reference) so `this` stays bound to whatever
          // implements `MetricsRecorder`. TypeScript already knows `snapshot` exists here from
          // the check above.
          let events = ctx.metrics.snapshot();
          if (opts.namespaceOverride !== undefined) {
            const namespace = opts.namespaceOverride;
            events = events.map((event) => applyNamespaceOverride(event, namespace));
          }
          if (events.length === 0) continue;

          const batch = new BatchNotifier();
          for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
          batch.seal();

          await ctx.output.send(events);
          if (ctx.acknowledgements) {
            const status = await batch.completion;
            if (status !== 'delivered') {
              ctx.logger.warn('internal_metrics: batch not delivered', { status });
            }
          }
        }
      },
    };
  },
});

export default internalMetricsSource;
