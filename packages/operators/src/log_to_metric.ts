import type { LogEvent } from '@ferrule/core';
import {
  createMetadata,
  MetricEvent,
  samplesToHistogram,
  type Event,
  type MetricKind,
  type MetricValue,
} from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import { defineTransform, DEFAULT_PORT, type TransformOutput } from '@ferrule/runtime';
import { toNumber } from './util/coerce.js';
import { compileTemplate, valueToTemplateText, type Template } from './util/template.js';

/**
 * `log_to_metric` — derives one or more metrics from each log event's fields. The original log
 * event is consumed (not forwarded); every produced metric carries a clone of its finalizers, so
 * acknowledgement completes once every derived metric has been delivered (fan-out semantics, the
 * same as routing one event to several sinks). A spec whose source field is missing on a given
 * event is silently skipped for that event.
 *
 * `name`, `namespace`, and tag values are `{field.path}` templates rendered against the log
 * event, so a single spec can fan out to many series (e.g. `name: "requests.{status}"`).
 */

function metricBase() {
  return {
    name: s
      .string({ minLength: 1 })
      .describe('metric name template, e.g. "http.requests.{status}"'),
    namespace: s.string().optional().describe('namespace template'),
    tags: s.record(s.string()).default(new Map()).describe('tag name -> value template'),
  };
}

const counterSpec = s.object({
  ...metricBase(),
  field: s.fieldPath().optional().describe('field to read; omit to always increment by 1'),
  increment_by_value: s
    .boolean()
    .default(false)
    .describe('increment by the field’s numeric value instead of by 1'),
});

const gaugeSpec = s.object({ ...metricBase(), field: s.fieldPath().describe('numeric field') });

const setSpec = s.object({
  ...metricBase(),
  field: s.fieldPath().describe('field whose (rendered) value is added to the set'),
});

const histogramSpec = s.object({
  ...metricBase(),
  field: s.fieldPath().describe('numeric field to observe'),
  buckets: s
    .array(s.number(), { minItems: 1 })
    .describe('strictly increasing histogram bucket upper bounds'),
});

const distributionSpec = s.object({
  ...metricBase(),
  field: s.fieldPath().describe('numeric field to observe'),
  statistic: s.enum(['histogram', 'summary'] as const).default('histogram'),
});

const metricSpecSchema = s.tagged('type', {
  counter: counterSpec,
  gauge: gaugeSpec,
  set: setSpec,
  histogram: histogramSpec,
  distribution: distributionSpec,
});

export type MetricSpec = Infer<typeof metricSpecSchema>;

export const logToMetricOptions = s.object({
  metrics: s
    .array(metricSpecSchema, { minItems: 1 })
    .describe('metrics to derive from each log event'),
});

export type LogToMetricOptions = Infer<typeof logToMetricOptions>;

interface CompiledSpec {
  readonly spec: MetricSpec;
  readonly name: Template;
  readonly namespace: Template | undefined;
  readonly tags: readonly [string, Template][];
}

function compile(spec: MetricSpec): CompiledSpec {
  return {
    spec,
    name: compileTemplate(spec.name),
    namespace: spec.namespace === undefined ? undefined : compileTemplate(spec.namespace),
    tags: [...spec.tags.entries()].map(([k, v]) => [k, compileTemplate(v)] as const),
  };
}

function buildValue(
  spec: MetricSpec,
  log: LogEvent,
): { value: MetricValue; kind: MetricKind } | undefined {
  switch (spec.type) {
    case 'counter': {
      let amount = 1;
      if (spec.field !== undefined) {
        const raw = log.get(spec.field);
        if (raw === undefined) return undefined;
        if (spec.increment_by_value) {
          const n = toNumber(raw);
          if (n === undefined) return undefined;
          amount = n;
        }
      }
      return { value: { type: 'counter', value: amount }, kind: 'incremental' };
    }
    case 'gauge': {
      const n = toNumber(log.get(spec.field));
      if (n === undefined) return undefined;
      return { value: { type: 'gauge', value: n }, kind: 'absolute' };
    }
    case 'set': {
      const raw = log.get(spec.field);
      if (raw === undefined) return undefined;
      return {
        value: { type: 'set', values: new Set([valueToTemplateText(raw)]) },
        kind: 'incremental',
      };
    }
    case 'histogram': {
      const n = toNumber(log.get(spec.field));
      if (n === undefined) return undefined;
      return {
        value: samplesToHistogram([{ value: n, rate: 1 }], spec.buckets),
        kind: 'incremental',
      };
    }
    case 'distribution': {
      const n = toNumber(log.get(spec.field));
      if (n === undefined) return undefined;
      return {
        value: {
          type: 'distribution',
          samples: [{ value: n, rate: 1 }],
          statistic: spec.statistic,
        },
        kind: 'incremental',
      };
    }
  }
}

export const logToMetricTransform = defineTransform<LogToMetricOptions>({
  kind: 'transform',
  type: 'log_to_metric',
  description: 'Derives counters, gauges, sets, histograms, or distributions from log fields.',
  options: logToMetricOptions,
  accepts: ['log'],
  produces: () => ['metric'],
  examples: [
    {
      title: 'Count requests by status code and observe latency',
      config: {
        metrics: [
          { type: 'counter', name: 'http.requests', tags: { status: '{http.status}' } },
          {
            type: 'histogram',
            name: 'http.request.duration_ms',
            field: 'duration_ms',
            buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
          },
        ],
      },
    },
  ],
  build: (options) => {
    const compiled = options.metrics.map(compile);
    return {
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          const log = event as LogEvent;
          const get = (path: Parameters<LogEvent['get']>[0]): ReturnType<LogEvent['get']> =>
            log.get(path);
          for (const c of compiled) {
            const built = buildValue(c.spec, log);
            if (built === undefined) continue;
            const metadataInit: Parameters<typeof createMetadata>[0] = {
              receivedAt: log.metadata.receivedAt,
              finalizers: log.metadata.finalizers.clone(),
            };
            if (log.metadata.sourceId !== undefined) metadataInit.sourceId = log.metadata.sourceId;
            if (log.metadata.sourceType !== undefined) {
              metadataInit.sourceType = log.metadata.sourceType;
            }
            const metadata = createMetadata(metadataInit);
            const init: ConstructorParameters<typeof MetricEvent>[0] = {
              name: c.name.render(get),
              tags: new Map(c.tags.map(([k, t]) => [k, t.render(get)])),
              kind: built.kind,
              value: built.value,
              timestamp: log.metadata.receivedAt,
              metadata,
            };
            if (c.namespace !== undefined) init.namespace = c.namespace.render(get);
            out.push(new MetricEvent(init), DEFAULT_PORT);
          }
          log.metadata.finalizers.finish('delivered');
        }
      },
    };
  },
});
