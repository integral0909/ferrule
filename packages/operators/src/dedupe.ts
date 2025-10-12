import type { LogEvent } from '@ferrule/core';
import { formatPath, walkLeaves, type Event, type Path } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  Metrics,
  type Counter,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import { fingerprintFields } from './util/hash.js';
import { TtlLruCache } from './util/lru.js';

/**
 * `dedupe` — drops log events that duplicate one recently seen within `ttl`, based on a
 * fingerprint of selected fields (or of every field except `ignore_fields`, when `fields` is
 * omitted). Bounded by an LRU of `cache_size` fingerprints, so memory never grows past that even
 * under a key space that never repeats.
 */

export const dedupeOptions = s.object({
  fields: s
    .array(s.fieldPath(), { minItems: 1 })
    .optional()
    .describe('fields whose values form the dedupe key; default: every field, minus ignore_fields'),
  ignore_fields: s
    .array(s.fieldPath())
    .default([])
    .describe('fields excluded from the dedupe key when `fields` is not given'),
  cache_size: s
    .integer({ min: 1 })
    .default(100_000)
    .describe('maximum number of fingerprints remembered (LRU-evicted beyond this)'),
  ttl: s
    .duration()
    .default(60_000)
    .describe('how long a fingerprint is remembered before a repeat is treated as new again'),
});

export type DedupeOptions = Infer<typeof dedupeOptions>;

function fingerprintOf(event: LogEvent, options: DedupeOptions): string {
  if (options.fields !== undefined) {
    const pairs: [string, ReturnType<typeof event.get>][] = options.fields.map((path) => [
      formatPath(path),
      event.get(path),
    ]);
    return fingerprintFields(pairs);
  }
  const ignore = new Set(options.ignore_fields.map((p) => formatPath(p)));
  const pairs: [string, ReturnType<typeof event.get>][] = [];
  walkLeaves(event.fields, (path: Path, value) => {
    const key = formatPath(path);
    if (!ignore.has(key)) pairs.push([key, value]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return fingerprintFields(pairs);
}

export const dedupeTransform = defineTransform<DedupeOptions>({
  kind: 'transform',
  type: 'dedupe',
  description: 'Drops log events that duplicate one recently seen, within a TTL.',
  options: dedupeOptions,
  accepts: ['log'],
  examples: [
    {
      title: 'Suppress repeated identical error messages for a minute',
      config: { fields: ['message', 'service'], cache_size: 50_000, ttl: '1m' },
    },
  ],
  build: (options) => {
    let ctx!: TransformContext;
    let droppedCounter!: Counter;
    const seen = new TtlLruCache<true>({ maxSize: options.cache_size });

    return {
      start(context) {
        ctx = context;
        droppedCounter = ctx.metrics.counter(Metrics.discardedEvents, { reason: 'duplicate' });
      },
      process(events: Event[], out: TransformOutput) {
        const nowMs = ctx.clock.monotonic();
        for (const event of events) {
          const key = fingerprintOf(event as LogEvent, options);
          if (seen.has(key, nowMs)) {
            droppedCounter.increment();
            event.metadata.finalizers.finish('delivered');
            continue;
          }
          seen.set(key, true, nowMs, options.ttl);
          out.push(event, DEFAULT_PORT);
        }
      },
      tickIntervalMs: options.ttl,
      tick() {
        seen.evictExpired(ctx.clock.monotonic());
      },
    };
  },
});
