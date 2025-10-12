import type { Event, MetricEvent } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  Metrics,
  type Counter,
  type TransformOutput,
} from '@ferrule/runtime';
import { BloomFilter } from './util/bloom.js';
import { fingerprintFields } from './util/hash.js';
import { LruCache } from './util/lru.js';

/**
 * `cardinality_limit` — caps the number of distinct tag-value combinations ("series") allowed
 * per metric name. Once a metric name has reached `limit` distinct combinations, a new one is
 * handled per `policy`:
 *
 * - `drop_event` (default): the event is discarded.
 * - `drop_tag`: the tags named in `drop_tag_keys` (default: every tag) are removed from the
 *   event, collapsing it into a lower-cardinality series instead of losing the event entirely.
 *
 * `mode: exact` (default) tracks every combination seen with a `Set`, giving exact limiting at
 * `O(limit)` memory per metric name. `mode: probabilistic` instead tracks combinations with a
 * Bloom filter sized for `limit` at `bloom_false_positive_rate`, trading a small, bounded chance
 * of under-counting (treating a new combination as already seen) for memory that does not grow
 * with the number of *rejected* combinations, which matters when a runaway tag is generating
 * far more than `limit` distinct values.
 */

export const cardinalityLimitOptions = s.object({
  limit: s
    .integer({ min: 1 })
    .default(1000)
    .describe('maximum distinct tag combinations allowed per metric name'),
  mode: s
    .enum(['exact', 'probabilistic'] as const)
    .default('exact')
    .describe('exact set tracking, or a bounded-memory Bloom filter'),
  policy: s
    .enum(['drop_event', 'drop_tag'] as const)
    .default('drop_event')
    .describe('what happens to an event that would exceed the limit'),
  drop_tag_keys: s
    .array(s.string(), { minItems: 1 })
    .optional()
    .describe('tag keys to strip when policy is drop_tag; default: every tag'),
  bloom_false_positive_rate: s
    .number({ greaterThan: 0, max: 0.5 })
    .default(0.01)
    .describe('target false-positive rate for mode: probabilistic'),
  max_series_tracked: s
    .integer({ min: 1 })
    .default(10_000)
    .describe('maximum number of distinct metric names tracked at once (LRU-evicted beyond this)'),
});

export type CardinalityLimitOptions = Infer<typeof cardinalityLimitOptions>;

interface Tracker {
  count: number;
  readonly exact: Set<string> | undefined;
  readonly bloom: BloomFilter | undefined;
}

function metricIdentityKey(metric: MetricEvent): string {
  return `${metric.series.namespace ?? ''}\u0000${metric.series.name}`;
}

function tagFingerprint(metric: MetricEvent): string {
  const pairs = [...metric.series.tags.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, v] as const);
  return fingerprintFields(pairs);
}

export const cardinalityLimitTransform = defineTransform<CardinalityLimitOptions>({
  kind: 'transform',
  type: 'cardinality_limit',
  description: 'Caps the number of distinct tag combinations tracked per metric name.',
  options: cardinalityLimitOptions,
  accepts: ['metric'],
  examples: [
    {
      title: 'Cap per-metric cardinality at 5000 combinations, dropping the offending tags',
      config: { limit: 5000, policy: 'drop_tag', drop_tag_keys: ['user_id'] },
    },
  ],
  build: (options) => {
    let dropped!: Counter;
    let overflowTags!: Counter;
    const trackers = new LruCache<Tracker>({ maxSize: options.max_series_tracked });

    const trackerFor = (key: string): Tracker => {
      let tracker = trackers.get(key);
      if (tracker === undefined) {
        tracker =
          options.mode === 'exact'
            ? { count: 0, exact: new Set<string>(), bloom: undefined }
            : {
                count: 0,
                exact: undefined,
                bloom: new BloomFilter(options.limit, options.bloom_false_positive_rate),
              };
        trackers.set(key, tracker);
      }
      return tracker;
    };

    /** Records `fingerprint` against `tracker` if room remains. Returns whether it is admitted. */
    const admit = (tracker: Tracker, fingerprint: string): boolean => {
      if (tracker.exact !== undefined) {
        if (tracker.exact.has(fingerprint)) return true;
        if (tracker.exact.size >= options.limit) return false;
        tracker.exact.add(fingerprint);
        tracker.count = tracker.exact.size;
        return true;
      }
      const bloom = tracker.bloom!;
      if (bloom.has(fingerprint)) return true;
      if (tracker.count >= options.limit) return false;
      bloom.add(fingerprint);
      tracker.count++;
      return true;
    };

    return {
      start(ctx) {
        dropped = ctx.metrics.counter(Metrics.discardedEvents, { reason: 'cardinality_limit' });
        overflowTags = ctx.metrics.counter('cardinality_limit_tags_dropped_total');
      },
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          const metric = event as MetricEvent;
          const key = metricIdentityKey(metric);
          const tracker = trackerFor(key);
          if (admit(tracker, tagFingerprint(metric))) {
            out.push(metric, DEFAULT_PORT);
            continue;
          }
          if (options.policy === 'drop_event') {
            dropped.increment();
            metric.metadata.finalizers.finish('delivered');
            continue;
          }
          const keysToStrip = options.drop_tag_keys ?? [...metric.series.tags.keys()];
          for (const tagKey of keysToStrip) metric.series.tags.delete(tagKey);
          overflowTags.increment(keysToStrip.length);
          admit(tracker, tagFingerprint(metric)); // best effort: record the reduced combination
          out.push(metric, DEFAULT_PORT);
        }
      },
    };
  },
});
