import { LogEvent, MetricEvent, type Event, type ValueMap } from '@ferrule/core';
import { RetryPolicy, type Clock } from '@ferrule/runtime';
import type { BatchOptions, RetryOptions } from './schema.js';

/** Small pieces shared by every sink's `build()` that don't belong in `client.ts`/`schema.ts`. */

/** Builds a `RetryPolicy` from the shared `retrySchema` shape, falling back to the toolkit's own
 * defaults for anything not set. */
export function buildRetryPolicy(
  options: RetryOptions | undefined,
  random?: () => number,
): RetryPolicy {
  return new RetryPolicy({
    initialDelayMs: options?.initialDelay ?? 100,
    maxDelayMs: options?.maxDelay ?? 30_000,
    multiplier: options?.multiplier ?? 2,
    ...(options?.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options?.maxElapsed !== undefined ? { maxElapsedMs: options.maxElapsed } : {}),
    ...(random !== undefined ? { random } : {}),
  });
}

export function batchTimeoutMs(options: BatchOptions | undefined): number {
  return options?.timeout ?? 1_000;
}

/** Projects any event kind into a `ValueMap` "context" for {@link compileFieldTemplate}: a
 * `LogEvent`'s own fields are used directly; metrics and spans get a small synthetic map of their
 * identifying fields. */
export function eventContext(event: Event): ValueMap {
  if (event instanceof LogEvent) return event.fields;
  if (event instanceof MetricEvent) {
    const context: ValueMap = new Map();
    context.set('name', event.series.name);
    if (event.series.namespace !== undefined) context.set('namespace', event.series.namespace);
    const tags: ValueMap = new Map();
    for (const [k, v] of event.series.tags) tags.set(k, v);
    context.set('tags', tags);
    if (event.timestamp !== undefined) context.set('timestamp', event.timestamp);
    return context;
  }
  const context: ValueMap = new Map();
  context.set('name', event.name);
  context.set('trace_id', event.traceIdHex);
  context.set('span_id', event.spanIdHex);
  context.set('attributes', event.attributes);
  context.set('resource', event.resource);
  return context;
}

/** Wall-clock `Date` for a sink's `ctx.clock`, for time-partitioned templates (object keys, etc.). */
export function clockDate(clock: Clock): Date {
  return clock.now().toDate();
}
