/**
 * Path read/write/delete over a {@link MetricEvent}, for programs compiled with
 * `target: 'metric'`. This is the metric counterpart of `@ferrule/core`'s `getPath`/`setPath` over
 * a log event's `fields` map: the compiler picks between the two *at compile time*
 * (`compile/compiler.ts`), so a log program's path closures are untouched and no per-event branch
 * is added to either kind.
 *
 * A metric is not a free-form map, so every write is validated here rather than trusted: a metric
 * whose `tags` held a non-string, or whose `kind` were `"incrementel"`, would break sinks far
 * downstream with no clue where it came from. A rejected write aborts the event with
 * `cause: 'abort'` and a reason naming the field — routed by the `script` transform's existing
 * `drop_on_abort`/`errors` port machinery, exactly like a `to_int(...)!` failure.
 *
 * The virtual field tree is `types/metricSchema.ts`'s schema, and matches `metric_to_log`'s
 * projection in `@ferrule/operators`. Reads of a field that does not apply to this metric's value
 * type (`.buckets` on a counter) return `null`; writes of one abort.
 */

import {
  Timestamp,
  type Bucket,
  type MetricEvent,
  type MetricValue,
  type PathSegment,
  type Quantile,
  type Sample,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import type { Span } from '../syntax/source.js';
import { abortSignal } from './signal.js';
import {
  isMetricFieldName,
  METRIC_COMMON_FIELDS,
  METRIC_VALUE_FIELDS,
  READONLY_METRIC_FIELDS,
  type MetricFieldName,
} from '../types/metricSchema.js';
import { deleteInValue, getInValue, setInValue } from './valuePath.js';

// ---- value conversions --------------------------------------------------------------------------

function sampleValue(sample: Sample): ValueMap {
  return new Map<string, Value>([
    ['value', sample.value],
    ['rate', sample.rate],
  ]);
}

function bucketValue(bucket: Bucket): ValueMap {
  return new Map<string, Value>([
    ['upper_limit', bucket.upperLimit],
    ['count', bucket.count],
  ]);
}

function quantileValue(quantile: Quantile): ValueMap {
  return new Map<string, Value>([
    ['quantile', quantile.quantile],
    ['value', quantile.value],
  ]);
}

// ---- write validation ---------------------------------------------------------------------------

function describe(value: Value | null): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'an int';
  if (typeof value === 'number') return 'a float';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'boolean') return 'a bool';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Map) return 'an object';
  if (value instanceof Timestamp) return 'a timestamp';
  return 'bytes';
}

function wrongType(field: string, expected: string, value: Value | null, span: Span): never {
  throw abortSignal(
    `cannot assign ${describe(value)} to \`.${field}\`: expected ${expected}`,
    span,
  );
}

function expectString(field: string, value: Value | null, span: Span): string {
  if (typeof value === 'string') return value;
  return wrongType(field, 'a string', value, span);
}

/** Every number inside a `MetricValue` is a float64, but accepts an int for ergonomics. */
function expectNumber(field: string, value: Value | null, span: Span): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return wrongType(field, 'a float', value, span);
}

function expectArray(field: string, value: Value | null, span: Span): readonly Value[] {
  if (Array.isArray(value)) return value;
  return wrongType(field, 'an array', value, span);
}

function memberNumber(field: string, entry: Value, key: string, span: Span): number {
  if (!(entry instanceof Map)) {
    throw abortSignal(
      `every element of \`.${field}\` must be an object, found ${describe(entry)}`,
      span,
    );
  }
  const raw = entry.get(key) ?? null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  throw abortSignal(
    `every element of \`.${field}\` must have a numeric '${key}', found ${describe(raw)}`,
    span,
  );
}

// ---- per-field accessors ------------------------------------------------------------------------

interface FieldAccess {
  /** `null` when the field does not apply to this metric's value type. */
  readonly get: (metric: MetricEvent) => Value | null;
  /** Absent for a read-only field. */
  readonly set?: (metric: MetricEvent, value: Value | null, span: Span) => void;
  /** Whether `null` clears the field rather than being a type error. */
  readonly nullable?: boolean;
}

/** Narrows `metric.value` to the one type `field` applies to, or aborts. */
function valueOfType<T extends MetricValue['type']>(
  metric: MetricEvent,
  types: readonly T[],
  field: string,
  span: Span,
): Extract<MetricValue, { type: T }> {
  if (!(types as readonly string[]).includes(metric.value.type)) {
    throw abortSignal(
      `cannot assign \`.${field}\`: this metric is a ${metric.value.type}, which has no \`.${field}\``,
      span,
    );
  }
  return metric.value as Extract<MetricValue, { type: T }>;
}

const FIELDS: Readonly<Record<MetricFieldName, FieldAccess>> = {
  name: {
    get: (m) => m.series.name,
    set: (m, v, span) => {
      m.series.name = expectString('name', v, span);
    },
  },
  namespace: {
    get: (m) => m.series.namespace ?? null,
    nullable: true,
    set: (m, v, span) => {
      if (v === null) delete m.series.namespace;
      else m.series.namespace = expectString('namespace', v, span);
    },
  },
  tags: {
    // A fresh map: unlike a log event's nested objects, a metric's tag map is not safe to alias
    // into a script local, where a later `t.x = 1` would write a non-string tag behind this
    // module's validation. Writes go back through `set`, which validates.
    get: (m) => new Map<string, Value>(m.series.tags),
    set: (m, v, span) => {
      if (!(v instanceof Map)) wrongType('tags', 'an object', v, span);
      const tags = new Map<string, string>();
      for (const [key, raw] of v) {
        // `null` means "not set", so `.tags.host = null` removes a tag just like
        // `del(.tags.host)` does, and a whole-map assignment can drop one the same way.
        if (raw === null) continue;
        if (typeof raw !== 'string') {
          throw abortSignal(`every tag must be a string, but '${key}' is ${describe(raw)}`, span);
        }
        tags.set(key, raw);
      }
      m.series.tags = tags;
    },
  },
  kind: {
    get: (m) => m.metricKind,
    set: (m, v, span) => {
      const kind = expectString('kind', v, span);
      if (kind !== 'incremental' && kind !== 'absolute') {
        throw abortSignal(
          `\`.kind\` must be "incremental" or "absolute", found ${JSON.stringify(kind)}`,
          span,
        );
      }
      m.metricKind = kind;
    },
  },
  type: { get: (m) => m.value.type },
  timestamp: {
    get: (m) => m.timestamp ?? null,
    nullable: true,
    set: (m, v, span) => {
      if (v === null) m.timestamp = undefined;
      else if (v instanceof Timestamp) m.timestamp = v;
      else wrongType('timestamp', 'a timestamp', v, span);
    },
  },
  interval_ms: {
    get: (m) => (m.intervalMs === undefined ? null : BigInt(Math.trunc(m.intervalMs))),
    nullable: true,
    set: (m, v, span) => {
      if (v === null) m.intervalMs = undefined;
      else if (typeof v === 'bigint') m.intervalMs = Number(v);
      else if (typeof v === 'number') m.intervalMs = v;
      else wrongType('interval_ms', 'an int', v, span);
    },
  },
  value: {
    get: (m) => (m.value.type === 'counter' || m.value.type === 'gauge' ? m.value.value : null),
    set: (m, v, span) => {
      valueOfType(m, ['counter', 'gauge'], 'value', span).value = expectNumber('value', v, span);
    },
  },
  values: {
    get: (m) => (m.value.type === 'set' ? [...m.value.values] : null),
    set: (m, v, span) => {
      const target = valueOfType(m, ['set'], 'values', span);
      const next = new Set<string>();
      for (const entry of expectArray('values', v, span)) {
        if (typeof entry !== 'string') {
          throw abortSignal(
            `every element of \`.values\` must be a string, found ${describe(entry)}`,
            span,
          );
        }
        next.add(entry);
      }
      target.values = next;
    },
  },
  samples: {
    get: (m) => (m.value.type === 'distribution' ? m.value.samples.map(sampleValue) : null),
    set: (m, v, span) => {
      const target = valueOfType(m, ['distribution'], 'samples', span);
      target.samples = expectArray('samples', v, span).map((entry) => ({
        value: memberNumber('samples', entry, 'value', span),
        rate: memberNumber('samples', entry, 'rate', span),
      }));
    },
  },
  statistic: {
    get: (m) => (m.value.type === 'distribution' ? m.value.statistic : null),
    set: (m, v, span) => {
      const target = valueOfType(m, ['distribution'], 'statistic', span);
      const statistic = expectString('statistic', v, span);
      if (statistic !== 'histogram' && statistic !== 'summary') {
        throw abortSignal(
          `\`.statistic\` must be "histogram" or "summary", found ${JSON.stringify(statistic)}`,
          span,
        );
      }
      target.statistic = statistic;
    },
  },
  buckets: {
    get: (m) => (m.value.type === 'histogram' ? m.value.buckets.map(bucketValue) : null),
    set: (m, v, span) => {
      const target = valueOfType(m, ['histogram'], 'buckets', span);
      const buckets: Bucket[] = expectArray('buckets', v, span).map((entry) => ({
        upperLimit: memberNumber('buckets', entry, 'upper_limit', span),
        count: memberNumber('buckets', entry, 'count', span),
      }));
      // Mirrors `@ferrule/core`'s own invariant (see `MetricValue`'s `histogram`): buckets are
      // non-cumulative and sorted, and downstream sinks index them positionally.
      for (let i = 0; i < buckets.length; i++) {
        if (!Number.isFinite(buckets[i]!.upperLimit)) {
          throw abortSignal('every `.buckets` upper_limit must be finite', span);
        }
        if (i > 0 && buckets[i]!.upperLimit <= buckets[i - 1]!.upperLimit) {
          throw abortSignal('`.buckets` upper_limits must be strictly increasing', span);
        }
      }
      target.buckets = buckets;
    },
  },
  quantiles: {
    get: (m) => (m.value.type === 'summary' ? m.value.quantiles.map(quantileValue) : null),
    set: (m, v, span) => {
      const target = valueOfType(m, ['summary'], 'quantiles', span);
      const quantiles: Quantile[] = expectArray('quantiles', v, span).map((entry) => ({
        quantile: memberNumber('quantiles', entry, 'quantile', span),
        value: memberNumber('quantiles', entry, 'value', span),
      }));
      for (const q of quantiles) {
        if (!(q.quantile >= 0 && q.quantile <= 1)) {
          throw abortSignal(
            `every \`.quantiles\` quantile must be within [0, 1], found ${q.quantile}`,
            span,
          );
        }
      }
      target.quantiles = quantiles;
    },
  },
  count: {
    get: (m) => (m.value.type === 'histogram' || m.value.type === 'summary' ? m.value.count : null),
    set: (m, v, span) => {
      valueOfType(m, ['histogram', 'summary'], 'count', span).count = expectNumber(
        'count',
        v,
        span,
      );
    },
  },
  sum: {
    get: (m) => (m.value.type === 'histogram' || m.value.type === 'summary' ? m.value.sum : null),
    set: (m, v, span) => {
      valueOfType(m, ['histogram', 'summary'], 'sum', span).sum = expectNumber('sum', v, span);
    },
  },
};

/** The fields that exist on `metric` right now, in schema order: common ones plus its value's. */
export function metricFieldsFor(metric: MetricEvent): readonly MetricFieldName[] {
  return [...METRIC_COMMON_FIELDS, ...(METRIC_VALUE_FIELDS[metric.value.type] ?? [])];
}

/** The whole metric as one object, for a bare `.` path read and for inline-test comparison. */
export function metricToValue(metric: MetricEvent): ValueMap {
  const out = new Map<string, Value>();
  for (const field of metricFieldsFor(metric)) {
    out.set(field, FIELDS[field].get(metric) ?? null);
  }
  return out;
}

function fieldOf(segments: readonly PathSegment[], span: Span): [MetricFieldName, FieldAccess] {
  const head = segments[0];
  if (typeof head !== 'string' || !isMetricFieldName(head)) {
    throw abortSignal(`a metric has no field \`.${String(head)}\``, span);
  }
  return [head, FIELDS[head]];
}

// ---- path operations ----------------------------------------------------------------------------

export function getMetricPath(metric: MetricEvent, segments: readonly PathSegment[]): Value | null {
  if (segments.length === 0) return metricToValue(metric);
  const head = segments[0];
  if (typeof head !== 'string' || !isMetricFieldName(head)) return null;
  const value = FIELDS[head].get(metric);
  if (segments.length === 1) return value;
  if (value === null) return null;
  return getInValue(value, segments.slice(1)) ?? null;
}

export function hasMetricPath(metric: MetricEvent, segments: readonly PathSegment[]): boolean {
  return getMetricPath(metric, segments) !== null;
}

/**
 * Writes `value` at `segments`. A path deeper than the field itself (`.buckets[0].count = 2`)
 * reads the field out as a plain `Value`, applies the write with the shared `setInValue`, then
 * puts the whole field back through its validating setter — so a deep write is checked exactly as
 * strictly as a whole-field one.
 */
export function setMetricPath(
  metric: MetricEvent,
  segments: readonly PathSegment[],
  value: Value,
  span: Span,
): void {
  if (segments.length === 0) {
    throw abortSignal('cannot replace the root of a metric event', span);
  }
  const [name, access] = fieldOf(segments, span);
  if (access.set === undefined) {
    throw abortSignal(`\`.${name}\` is read-only`, span);
  }
  if (segments.length === 1) {
    access.set(metric, value, span);
    return;
  }
  const current = access.get(metric);
  if (current === null) {
    throw abortSignal(
      `cannot assign into \`.${name}\`: this metric is a ${metric.value.type}, which has no \`.${name}\``,
      span,
    );
  }
  access.set(metric, setInValue(current, segments.slice(1), value), span);
}

/**
 * Removes the value at `segments`. Clearing a whole field is only meaningful for the optional
 * ones (`.namespace`, `.timestamp`, `.interval_ms`, and a single tag); anything else aborts
 * rather than silently doing nothing, since `del(.value)` has no sensible meaning for a counter.
 */
export function deleteMetricPath(
  metric: MetricEvent,
  segments: readonly PathSegment[],
  span: Span,
): Value | null {
  if (segments.length === 0) {
    throw abortSignal('cannot delete the root of a metric event', span);
  }
  const [name, access] = fieldOf(segments, span);
  if (access.set === undefined) {
    throw abortSignal(`\`.${name}\` is read-only`, span);
  }
  if (segments.length === 1) {
    if (access.nullable !== true) {
      throw abortSignal(`\`.${name}\` cannot be removed from a metric event`, span);
    }
    const previous = access.get(metric);
    access.set(metric, null, span);
    return previous;
  }
  const current = access.get(metric);
  if (current === null) return null;
  const removed = deleteInValue(current, segments.slice(1)) ?? null;
  access.set(metric, current, span);
  return removed;
}

/**
 * Applies one field of an inline test's `given` block to a freshly built metric
 * (`compile/testRunner.ts`). Shares the same validating setters as a program's own writes, so a
 * test fixture cannot describe a metric a script could not have produced.
 */
export function setMetricField(metric: MetricEvent, name: string, value: Value, span: Span): void {
  setMetricPath(metric, [name], value, span);
}

/** Whether `name` names a field a script may assign to. */
export function isWritableMetricField(name: string): boolean {
  return isMetricFieldName(name) && !READONLY_METRIC_FIELDS.has(name);
}
