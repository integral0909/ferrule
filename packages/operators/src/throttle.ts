import type { Event } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  Metrics,
  type Counter,
  type OutputPort,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import { getEventField } from './util/fields.js';
import { LruCache } from './util/lru.js';
import { refillRatePerMs, TokenBucket } from './util/token-bucket.js';
import { valueToTemplateText } from './util/template.js';

/**
 * `throttle` — a per-key token bucket rate limiter: at most `threshold` events per `window` for
 * each distinct value of `key_field` (or one shared bucket for every event, if `key_field` is
 * omitted). Excess events are dropped (or routed to the `dropped` port, if `emit_dropped` is
 * set). Per-key state is bounded by an LRU of `max_keys` buckets, so an unbounded key space
 * (e.g. a client IP) cannot exhaust memory: evicting a bucket simply resets that key's budget.
 */

const DROPPED_PORT = 'dropped';
const GLOBAL_KEY = '\u0000global';

export const throttleOptions = s.object({
  threshold: s.integer({ min: 1 }).default(1000).describe('maximum events per key per window'),
  window: s.duration().default(1000).describe('the rate limiting window'),
  key_field: s
    .fieldPath()
    .optional()
    .describe('field identifying the bucket; omit for one bucket shared by every event'),
  max_keys: s
    .integer({ min: 1 })
    .default(100_000)
    .describe('maximum number of distinct keys tracked at once (LRU-evicted beyond this)'),
  emit_dropped: s
    .boolean()
    .default(false)
    .describe('route throttled events to the `dropped` port instead of discarding them'),
});

export type ThrottleOptions = Infer<typeof throttleOptions>;

export const throttleTransform = defineTransform<ThrottleOptions>({
  kind: 'transform',
  type: 'throttle',
  description: 'Rate-limits events per key using a token bucket.',
  options: throttleOptions,
  accepts: ['log', 'metric', 'span'],
  outputs: (options): readonly OutputPort[] =>
    options.emit_dropped ? [{ name: DROPPED_PORT, description: 'events over the rate limit' }] : [],
  examples: [
    {
      title: 'Allow 100 events per second per client IP',
      config: { threshold: 100, window: '1s', key_field: 'client.ip', emit_dropped: true },
    },
  ],
  build: (options) => {
    let ctx!: TransformContext;
    let dropped!: Counter;
    let evicted!: Counter;
    const refillPerMs = refillRatePerMs(options.threshold, options.window);
    const buckets = new LruCache<TokenBucket>({
      maxSize: options.max_keys,
      onEvict: () => evicted.increment(),
    });

    const keyFor = (event: Event): string => {
      if (options.key_field === undefined) return GLOBAL_KEY;
      const value = getEventField(event, options.key_field);
      return value === undefined ? '' : valueToTemplateText(value);
    };

    return {
      start(context) {
        ctx = context;
        dropped = ctx.metrics.counter(Metrics.discardedEvents, { reason: 'throttled' });
        evicted = ctx.metrics.counter('throttle_bucket_evictions_total');
      },
      process(events: Event[], out: TransformOutput) {
        const nowMs = ctx.clock.monotonic();
        for (const event of events) {
          const key = keyFor(event);
          let bucket = buckets.get(key);
          if (bucket === undefined) {
            bucket = new TokenBucket(options.threshold, refillPerMs, nowMs);
            buckets.set(key, bucket);
          }
          if (bucket.tryRemove(1, nowMs)) {
            out.push(event, DEFAULT_PORT);
            continue;
          }
          dropped.increment();
          if (options.emit_dropped) {
            out.push(event, DROPPED_PORT);
          } else {
            event.metadata.finalizers.finish('delivered');
          }
        }
      },
    };
  },
});
