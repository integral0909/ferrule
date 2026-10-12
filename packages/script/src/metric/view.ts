import {
  kindOf,
  LogEvent,
  Timestamp,
  type MetricEvent,
  type MetricKind,
  type MetricValue,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { abortSignal } from '../runtime/signal.js';
import type { Span } from '../syntax/source.js';

/**
 * Builds the `LogEvent`-shaped view of `event` that a compiled program actually runs against (see
 * `docs/language/design.md`'s "Metric events" and `metric/schema.ts`'s field-by-field doc for the
 * shape). The view shares `event.metadata` by reference rather than cloning it — it never escapes
 * the caller (a fresh one is built per run and discarded once {@link applyViewToMetric} has read
 * it back), so there is nothing to keep separate the way a genuinely new event would need.
 *
 * Every numeric leaf a `MetricValue` can hold is a float64 (`@ferrule/core`'s `MetricValue` never
 * uses an integer), so every number here is written as a Ferrule Script `float` (a plain JS
 * `number`), never coerced through `fromPlain`'s "whole numbers become `int`" heuristic — the
 * `program.run` round trip in {@link applyViewToMetric} depends on that being exact.
 */
export function metricEventToView(event: MetricEvent): LogEvent {
  const fields: ValueMap = new Map();
  fields.set('name', event.series.name);
  fields.set('namespace', event.series.namespace ?? null);
  const tags: ValueMap = new Map();
  for (const [key, value] of event.series.tags) tags.set(key, value);
  fields.set('tags', tags);
  fields.set('kind', event.metricKind);
  fields.set('value_type', event.value.type);
  fields.set('timestamp', event.timestamp ?? null);
  fields.set('interval_ms', event.intervalMs ?? null);
  setValueFields(fields, event.value);
  return new LogEvent(fields, event.metadata);
}

function setValueFields(fields: ValueMap, value: MetricValue): void {
  switch (value.type) {
    case 'counter':
    case 'gauge':
      fields.set('value', value.value);
      return;
    case 'set':
      fields.set('values', [...value.values]);
      return;
    case 'distribution':
      fields.set('statistic', value.statistic);
      fields.set(
        'samples',
        value.samples.map((s) => objectOf({ value: s.value, rate: s.rate })),
      );
      return;
    case 'histogram':
      fields.set(
        'buckets',
        value.buckets.map((b) => objectOf({ upper_limit: b.upperLimit, count: b.count })),
      );
      fields.set('count', value.count);
      fields.set('sum', value.sum);
      return;
    case 'summary':
      fields.set(
        'quantiles',
        value.quantiles.map((q) => objectOf({ quantile: q.quantile, value: q.value })),
      );
      fields.set('count', value.count);
      fields.set('sum', value.sum);
      return;
  }
}

function objectOf(record: Readonly<Record<string, number>>): ValueMap {
  const map: ValueMap = new Map();
  for (const [key, value] of Object.entries(record)) map.set(key, value);
  return map;
}

/**
 * Converts `view`'s final fields — after a compiled program has run against the
 * {@link metricEventToView} of `event` — back into `event`, mutating it in place. `span` is used
 * for the `Span` any thrown `ScriptSignal` carries (the compiled program's root span is the usual
 * choice, matching `outcomeForError`'s `fallbackSpan` for an internal error).
 *
 * Throws (via `abortSignal`, `cause: 'abort'`) describing the first structural problem found, for
 * a caller to turn into the same kind of `Outcome` a `program.run` abort produces (e.g. with
 * `outcomeForError`) — this is the real enforcement behind "every write is validated": the
 * checker's compile-time typing (`metric/schema.ts`) is best-effort (an open `rest`/`any` along a
 * path isn't checked), but every metric this function produces is fully validated, every time.
 *
 * `event.value.type` is never read back from the view's `.value_type` field — the checker already
 * rejects assigning to it (`metricReadonlyPaths`, diagnostic `E311`), and this is the second half
 * of that decision: changing a metric's value type is not supported, so the fields read back here
 * are always whichever ones the event's own (unchanged) type calls for, regardless of what a
 * program not checked by this package's `check()` might have done to `.value_type` at runtime.
 */
export function applyViewToMetric(event: MetricEvent, view: LogEvent, span: Span): void {
  const fields = view.fields;

  event.series.name = requireString(fields.get('name'), 'name', span);

  const namespace = fields.get('namespace');
  if (namespace === undefined || namespace === null) delete event.series.namespace;
  else event.series.namespace = requireString(namespace, 'namespace', span);

  event.series.tags = requireTags(fields.get('tags'), span);
  event.metricKind = requireMetricKind(fields.get('kind'), span);

  const timestamp = fields.get('timestamp');
  if (timestamp === undefined || timestamp === null) event.timestamp = undefined;
  else if (timestamp instanceof Timestamp) event.timestamp = timestamp;
  else throw abortSignal("metric '.timestamp' must be a timestamp or null", span);

  const intervalMs = fields.get('interval_ms');
  if (intervalMs === undefined || intervalMs === null) event.intervalMs = undefined;
  else if (typeof intervalMs === 'number') event.intervalMs = intervalMs;
  else throw abortSignal("metric '.interval_ms' must be a float or null", span);

  event.value = readBackValue(event.value.type, fields, span);
}

function readBackValue(type: MetricValue['type'], fields: ValueMap, span: Span): MetricValue {
  switch (type) {
    case 'counter':
      return { type: 'counter', value: requireFloat(fields.get('value'), '.value', span) };
    case 'gauge':
      return { type: 'gauge', value: requireFloat(fields.get('value'), '.value', span) };
    case 'set': {
      const values = new Set<string>();
      for (const item of requireArray(fields.get('values'), '.values', span)) {
        if (typeof item !== 'string') {
          throw abortSignal(
            `metric '.values' must contain only strings, found ${kindOf(item)}`,
            span,
          );
        }
        values.add(item);
      }
      return { type: 'set', values };
    }
    case 'distribution': {
      const statistic = fields.get('statistic');
      if (statistic !== 'histogram' && statistic !== 'summary') {
        throw abortSignal('metric \'.statistic\' must be "histogram" or "summary"', span);
      }
      const samples = requireArray(fields.get('samples'), '.samples', span).map((item) =>
        readSample(item, span),
      );
      return { type: 'distribution', statistic, samples };
    }
    case 'histogram': {
      const buckets = requireArray(fields.get('buckets'), '.buckets', span).map((item) =>
        readBucket(item, span),
      );
      return {
        type: 'histogram',
        buckets,
        count: requireFloat(fields.get('count'), '.count', span),
        sum: requireFloat(fields.get('sum'), '.sum', span),
      };
    }
    case 'summary': {
      const quantiles = requireArray(fields.get('quantiles'), '.quantiles', span).map((item) =>
        readQuantile(item, span),
      );
      return {
        type: 'summary',
        quantiles,
        count: requireFloat(fields.get('count'), '.count', span),
        sum: requireFloat(fields.get('sum'), '.sum', span),
      };
    }
  }
}

function readSample(item: Value, span: Span): { value: number; rate: number } {
  const obj = requireObject(item, '.samples[]', span);
  return {
    value: requireFloat(obj.get('value'), '.samples[].value', span),
    rate: requireFloat(obj.get('rate'), '.samples[].rate', span),
  };
}

function readBucket(item: Value, span: Span): { upperLimit: number; count: number } {
  const obj = requireObject(item, '.buckets[]', span);
  return {
    upperLimit: requireFloat(obj.get('upper_limit'), '.buckets[].upper_limit', span),
    count: requireFloat(obj.get('count'), '.buckets[].count', span),
  };
}

function readQuantile(item: Value, span: Span): { quantile: number; value: number } {
  const obj = requireObject(item, '.quantiles[]', span);
  return {
    quantile: requireFloat(obj.get('quantile'), '.quantiles[].quantile', span),
    value: requireFloat(obj.get('value'), '.quantiles[].value', span),
  };
}

function requireString(value: Value | undefined, field: string, span: Span): string {
  if (typeof value !== 'string') {
    throw abortSignal(
      `metric '.${field}' must be a string, found ${describeOptional(value)}`,
      span,
    );
  }
  return value;
}

function requireFloat(value: Value | undefined, field: string, span: Span): number {
  if (typeof value !== 'number') {
    throw abortSignal(`metric '${field}' must be a float, found ${describeOptional(value)}`, span);
  }
  return value;
}

function requireArray(value: Value | undefined, field: string, span: Span): Value[] {
  if (!Array.isArray(value)) {
    throw abortSignal(`metric '${field}' must be an array, found ${describeOptional(value)}`, span);
  }
  return value;
}

function requireObject(value: Value, field: string, span: Span): ValueMap {
  if (!(value instanceof Map)) {
    throw abortSignal(`metric '${field}' must be an object, found ${kindOf(value)}`, span);
  }
  return value;
}

function requireTags(value: Value | undefined, span: Span): Map<string, string> {
  if (!(value instanceof Map)) {
    throw abortSignal(`metric '.tags' must be an object, found ${describeOptional(value)}`, span);
  }
  const tags = new Map<string, string>();
  for (const [key, tagValue] of value) {
    if (typeof tagValue !== 'string') {
      throw abortSignal(`metric tag '${key}' must be a string, found ${kindOf(tagValue)}`, span);
    }
    tags.set(key, tagValue);
  }
  return tags;
}

function requireMetricKind(value: Value | undefined, span: Span): MetricKind {
  if (value === 'incremental' || value === 'absolute') return value;
  throw abortSignal(
    `metric '.kind' must be "incremental" or "absolute", found ${describeOptional(value)}`,
    span,
  );
}

function describeOptional(value: Value | undefined): string {
  return value === undefined ? 'nothing (deleted)' : kindOf(value);
}
