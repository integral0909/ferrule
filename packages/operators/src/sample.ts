import type { Event } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  Metrics,
  type Counter,
  type TransformOutput,
} from '@ferrule/runtime';
import { getEventField } from './util/fields.js';
import { hashString, unitInterval } from './util/hash.js';
import { valueToTemplateText } from './util/template.js';

/**
 * `sample` — deterministic sampling by rate.
 *
 * Without a `key_field`, sampling uses an error-diffusion ("Bresenham") counter: of any `N`
 * consecutive events it keeps a count that never strays from `rate * N` by more than one,
 * deterministically and with no randomness — the same sequence of keep/drop decisions every run.
 *
 * With a `key_field`, all events sharing the same field value get the same decision (consistent
 * hashing of the field's rendered text into `[0, 1)`, compared against `rate`), which is what
 * you want when sampling needs to keep whole traces, sessions, or users together rather than
 * individual events.
 *
 * `exclude` always keeps events matching any listed field/value pair, regardless of `rate` —
 * typically used to always keep errors while sampling everything else.
 */

const excludeRuleSchema = s.object({
  field: s.fieldPath().describe('field to test'),
  values: s
    .array(s.string(), { minItems: 1 })
    .describe('the field, rendered as text, always bypasses sampling if it matches any of these'),
});

export const sampleOptions = s.object({
  rate: s
    .number({ min: 0, max: 1 })
    .default(1)
    .describe('fraction of events to keep, from 0 (drop all) to 1 (keep all)'),
  key_field: s
    .fieldPath()
    .optional()
    .describe('when set, events with the same value at this field always get the same decision'),
  exclude: s
    .array(excludeRuleSchema)
    .default([])
    .describe('rules that always keep a matching event, bypassing the rate'),
});

export type SampleOptions = Infer<typeof sampleOptions>;

export const sampleTransform = defineTransform<SampleOptions>({
  kind: 'transform',
  type: 'sample',
  description: 'Deterministically samples events by rate, optionally keyed by a field.',
  options: sampleOptions,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Keep 10% of events, but always keep 5xx responses and whole traces together',
      config: {
        rate: 0.1,
        key_field: 'trace_id',
        exclude: [{ field: 'http.status', values: ['500', '502', '503', '504'] }],
      },
    },
  ],
  build: (options) => {
    let errorAccumulator = 0;
    let discarded!: Counter;

    const unkeyedDecision = (): boolean => {
      errorAccumulator += options.rate;
      if (errorAccumulator < 1) return false;
      errorAccumulator -= 1;
      return true;
    };

    return {
      start(ctx) {
        discarded = ctx.metrics.counter(Metrics.discardedEvents, { reason: 'sampled' });
      },
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          if (isExcluded(event, options)) {
            out.push(event, DEFAULT_PORT);
            continue;
          }
          const keep =
            options.key_field !== undefined ? keyedDecision(event, options) : unkeyedDecision();
          if (keep) {
            out.push(event, DEFAULT_PORT);
          } else {
            discarded.increment();
            event.metadata.finalizers.finish('delivered');
          }
        }
      },
    };
  },
});

function isExcluded(event: Event, options: SampleOptions): boolean {
  if (options.exclude.length === 0) return false;
  for (const rule of options.exclude) {
    const value = getEventField(event, rule.field);
    if (value === undefined) continue;
    const text = valueToTemplateText(value);
    if (rule.values.includes(text)) return true;
  }
  return false;
}

function keyedDecision(event: Event, options: SampleOptions): boolean {
  if (options.rate >= 1) return true;
  if (options.rate <= 0) return false;
  const value = getEventField(event, options.key_field!);
  const text = value === undefined ? '' : valueToTemplateText(value);
  return unitInterval(hashString(text)) < options.rate;
}
