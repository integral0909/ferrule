import { LogEvent, MetricEvent, type Event, type ValueMap } from '@ferrule/core';
import type { BatchOptions } from '../fragments.js';

/** Small pieces shared by every sink's `build()` that don't belong in `client.ts`/`schema.ts`. */

export { buildRetryPolicy, clockDate } from '../fragments.js';

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
