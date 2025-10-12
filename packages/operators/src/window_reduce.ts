import {
  cloneValue,
  compareValues,
  createMetadata,
  formatPath,
  LogEvent,
  type Event,
  type Path,
  type Value,
} from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  type Counter,
  type Gauge,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import { conditionSchema, evaluateCondition, type ConditionSpec } from './util/condition.js';
import { fingerprintFields } from './util/hash.js';
import { toNumber } from './util/coerce.js';
import { valueToTemplateText } from './util/template.js';

/**
 * `window_reduce` — merges log events that belong together (multiline stack traces,
 * request/response pairs, anything with a natural grouping key and a natural end) into one log
 * event.
 *
 * Events are grouped by the values at `group_by`. `end_when` (a field condition, not a
 * language — see {@link conditionSchema}) flushes a group immediately when it matches; without
 * it, a group flushes on `max_events`, `max_bytes`, `max_duration` (checked on every tick), or
 * pipeline shutdown. `start_when` additionally forces an *earlier* open group with the same key
 * to flush before this event starts a new one, useful when a start marker can appear before its
 * predecessor's natural end was seen.
 *
 * The merged event's fields default to those of `base_event` ("first" or "last", default
 * "first"); `merge_strategies` overrides specific fields with `concat`, `array`, `sum`, `max`,
 * `min`, `first`, `last`, or `count`. The merged event carries the group's finalizers merged
 * together, so acknowledgement completes once the merged event is delivered.
 */

const mergeStrategyEnum = s.enum([
  'concat',
  'array',
  'sum',
  'max',
  'min',
  'first',
  'last',
  'count',
] as const);

const mergeRuleSchema = s.object({
  field: s.fieldPath().describe('field to compute in the merged event'),
  strategy: mergeStrategyEnum,
  separator: s.string().default(' ').describe('joiner for strategy: concat'),
});

export const windowReduceOptions = s.object({
  group_by: s
    .array(s.fieldPath(), { minItems: 1 })
    .describe('fields whose values form the group key'),
  start_when: conditionSchema()
    .optional()
    .describe('flush an existing open group for this key before starting a new one on match'),
  end_when: conditionSchema().optional().describe('flush the group immediately when this matches'),
  merge_strategies: s
    .array(mergeRuleSchema)
    .default([])
    .describe('per-field merge strategy; fields not listed take the base event’s value'),
  base_event: s
    .enum(['first', 'last'] as const)
    .default('first')
    .describe('which event in the group supplies fields not covered by merge_strategies'),
  max_events: s.integer({ min: 1 }).optional().describe('flush after this many events accumulate'),
  max_bytes: s.byteSize().optional().describe('flush after the group reaches this estimated size'),
  max_duration: s
    .duration({ minMs: 1 })
    .optional()
    .describe('flush this long after the group started'),
});

export type WindowReduceOptions = Infer<typeof windowReduceOptions>;
type MergeRule = Infer<typeof mergeRuleSchema>;

interface GroupState {
  readonly key: string;
  events: LogEvent[];
  bytes: number;
  firstSeenMonoMs: number;
}

function groupKeyOf(log: LogEvent, fields: readonly Path[]): string {
  return fingerprintFields(fields.map((f) => [formatPath(f), log.get(f)] as const));
}

function mergedFieldValue(events: readonly LogEvent[], rule: MergeRule): Value | undefined {
  const present = events.map((e) => e.get(rule.field)).filter((v): v is Value => v !== undefined);
  switch (rule.strategy) {
    case 'count':
      return BigInt(events.length);
    case 'first':
      return present[0];
    case 'last':
      return present[present.length - 1];
    case 'array':
      return present;
    case 'concat':
      return present.map((v) => valueToTemplateText(v)).join(rule.separator);
    case 'sum': {
      let total = 0;
      for (const v of present) total += toNumber(v) ?? 0;
      return total;
    }
    case 'max':
    case 'min': {
      if (present.length === 0) return undefined;
      // Not `present[0]!`: the non-null assertion strips `null` along with `undefined`, but
      // `null` is itself a valid `Value`.
      let best: Value = present[0] as Value;
      for (const v of present.slice(1)) {
        const c = compareValues(v, best);
        if (rule.strategy === 'max' ? c > 0 : c < 0) best = v;
      }
      return best;
    }
  }
}

function buildMergedEvent(state: GroupState, options: WindowReduceOptions): LogEvent {
  const baseSource =
    options.base_event === 'first' ? state.events[0]! : state.events[state.events.length - 1]!;
  // Built from scratch (not `.clone()`) so the merged event starts with fresh, empty finalizers:
  // the group's finalizers are merged in by the caller, which transfers (not clones) ownership.
  const metadataInit: Parameters<typeof createMetadata>[0] = {
    receivedAt: baseSource.metadata.receivedAt,
  };
  if (baseSource.metadata.sourceId !== undefined) {
    metadataInit.sourceId = baseSource.metadata.sourceId;
  }
  if (baseSource.metadata.sourceType !== undefined) {
    metadataInit.sourceType = baseSource.metadata.sourceType;
  }
  const merged = new LogEvent(cloneValue(baseSource.fields), createMetadata(metadataInit));
  for (const rule of options.merge_strategies) {
    const value = mergedFieldValue(state.events, rule);
    if (value !== undefined) merged.set(rule.field, value);
  }
  return merged;
}

export const windowReduceTransform = defineTransform<WindowReduceOptions>({
  kind: 'transform',
  type: 'window_reduce',
  description: 'Merges related log events (multiline traces, request/response pairs) into one.',
  options: windowReduceOptions,
  accepts: ['log'],
  examples: [
    {
      title: 'Fold Java stack traces into their originating log line',
      config: {
        group_by: ['thread'],
        end_when: {
          type: 'not',
          condition: { type: 'field_matches', field: 'message', pattern: '^\\s' },
        },
        merge_strategies: [{ field: 'message', strategy: 'concat', separator: '\n' }],
        max_events: 500,
        max_duration: '5s',
      },
    },
  ],
  build: (options) => {
    let ctx!: TransformContext;
    let activeGroups!: Gauge;
    let forcedFlushes!: Counter;
    const groups = new Map<string, GroupState>();

    const emit = (state: GroupState, out: TransformOutput): void => {
      const merged = buildMergedEvent(state, options);
      for (const source of state.events) {
        merged.metadata.finalizers.merge(source.metadata.finalizers);
      }
      out.push(merged, DEFAULT_PORT);
      groups.delete(state.key);
      activeGroups.set(groups.size);
    };

    const append = (state: GroupState, log: LogEvent): void => {
      state.events.push(log);
      state.bytes += log.estimatedSize();
    };

    const matches = (spec: ConditionSpec | undefined, log: LogEvent): boolean =>
      spec !== undefined && evaluateCondition(spec, (p) => log.get(p));

    const process = (events: Event[], out: TransformOutput): void => {
      const nowMs = ctx.clock.monotonic();
      for (const event of events) {
        const log = event as LogEvent;
        const key = groupKeyOf(log, options.group_by);
        let state = groups.get(key);

        if (state !== undefined && matches(options.start_when, log)) {
          emit(state, out);
          state = undefined;
        }
        if (state === undefined) {
          state = { key, events: [], bytes: 0, firstSeenMonoMs: nowMs };
          groups.set(key, state);
          activeGroups.set(groups.size);
        }
        append(state, log);

        const shouldFlush =
          matches(options.end_when, log) ||
          (options.max_events !== undefined && state.events.length >= options.max_events) ||
          (options.max_bytes !== undefined && state.bytes >= options.max_bytes);
        if (shouldFlush) emit(state, out);
      }
    };

    const flush = (out: TransformOutput): void => {
      for (const state of [...groups.values()]) emit(state, out);
    };

    const start = (context: TransformContext): void => {
      ctx = context;
      activeGroups = ctx.metrics.gauge('window_reduce_active_groups');
      forcedFlushes = ctx.metrics.counter('window_reduce_forced_flushes_total');
    };

    const maxDuration = options.max_duration;
    if (maxDuration === undefined) return { start, process, flush };

    return {
      start,
      process,
      flush,
      tickIntervalMs: maxDuration,
      tick(_now, out) {
        const nowMs = ctx.clock.monotonic();
        for (const state of [...groups.values()]) {
          if (nowMs - state.firstSeenMonoMs >= maxDuration) {
            forcedFlushes.increment();
            emit(state, out);
          }
        }
      },
    };
  },
});
