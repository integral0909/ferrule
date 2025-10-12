import { isLogEvent, isMetricEvent, type Event } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import { defineTransform, type OutputPort, type TransformOutput } from '@ferrule/runtime';

/**
 * `split_by_kind` — routes logs, metrics, and spans to separate named ports (`logs`, `metrics`,
 * `spans`), so a downstream sink that only accepts one event kind can be wired directly. Port
 * names are configurable in case they collide with something else in a pipeline.
 */

export const splitByKindOptions = s.object({
  log_port: s.string({ minLength: 1 }).default('logs').describe('port log events are sent to'),
  metric_port: s
    .string({ minLength: 1 })
    .default('metrics')
    .describe('port metric events are sent to'),
  span_port: s.string({ minLength: 1 }).default('spans').describe('port span events are sent to'),
});

export type SplitByKindOptions = Infer<typeof splitByKindOptions>;

export const splitByKindTransform = defineTransform<SplitByKindOptions>({
  kind: 'transform',
  type: 'split_by_kind',
  description: 'Routes logs, metrics, and spans to separate output ports.',
  options: splitByKindOptions,
  accepts: ['log', 'metric', 'span'],
  outputs: (options): readonly OutputPort[] => [
    { name: options.log_port, description: 'log events' },
    { name: options.metric_port, description: 'metric events' },
    { name: options.span_port, description: 'span events' },
  ],
  examples: [{ title: 'Default port names', config: {} }],
  build: (options) => ({
    process(events: Event[], out: TransformOutput) {
      for (const event of events) {
        const port = isLogEvent(event)
          ? options.log_port
          : isMetricEvent(event)
            ? options.metric_port
            : options.span_port;
        out.push(event, port);
      }
    },
  }),
});
