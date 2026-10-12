import {
  formatValue,
  isValueArray,
  isValueMap,
  toHex,
  valuesEqual,
  type Event,
  type MetricEvent,
  type SpanEvent,
  type Value,
  type ValueMap,
} from '@ferrule/core';

/**
 * Value-level diffing for pipeline test expectations: turns any `Event` into a plain `Value`
 * (a `ValueMap` for logs; a synthesized `ValueMap` describing a metric's or span's shape for
 * metrics/spans) so `outputs.<sink>.events` expectations in a test file can compare across event
 * kinds uniformly, and reports every mismatch (not just the first) with a dotted/bracketed path,
 * using `@ferrule/core`'s own `valuesEqual`/`formatValue` so "equal" here means exactly what it
 * means everywhere else in Ferrule (int ≠ float, object key order irrelevant, ...).
 */

export type MatchMode = 'exact' | 'subset';

export interface FieldDiff {
  /** A dotted/bracketed path into the compared value, e.g. `status` or `tags.host` or `items[2]`. */
  readonly path: string;
  /** `undefined` when `actual` has a field `expected` never mentioned (only reported in `exact` mode). */
  readonly expected: Value | undefined;
  /** `undefined` when `expected` names a field `actual` is missing. */
  readonly actual: Value | undefined;
}

function joinPath(base: string, segment: string): string {
  return base === '' ? segment : `${base}.${segment}`;
}

function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

/**
 * Diffs `actual` against `expected`. In `subset` mode (the default expectation match mode),
 * fields `expected` doesn't mention are ignored; in `exact` mode, every field of `actual` must
 * also appear in `expected`. Arrays are compared element-by-element at equal length in either
 * mode (a length mismatch is reported as one diff at the array's own path) — array elements
 * beyond `expected`'s own length are not a documented "subset of an array" concept here.
 */
export function diffValues(
  expected: Value,
  actual: Value | undefined,
  mode: MatchMode,
  path = '',
): FieldDiff[] {
  if (actual === undefined) return [{ path, expected, actual: undefined }];

  if (isValueMap(expected)) {
    if (!isValueMap(actual)) return [{ path, expected, actual }];
    const diffs: FieldDiff[] = [];
    for (const [key, value] of expected) {
      diffs.push(...diffValues(value, actual.get(key), mode, joinPath(path, key)));
    }
    if (mode === 'exact') {
      for (const key of actual.keys()) {
        if (!expected.has(key)) {
          diffs.push({ path: joinPath(path, key), expected: undefined, actual: actual.get(key) });
        }
      }
    }
    return diffs;
  }

  if (isValueArray(expected)) {
    if (!isValueArray(actual) || actual.length !== expected.length) {
      return [{ path, expected, actual }];
    }
    const diffs: FieldDiff[] = [];
    expected.forEach((value, i) => {
      diffs.push(...diffValues(value, actual[i], mode, indexPath(path, i)));
    });
    return diffs;
  }

  return valuesEqual(expected, actual) ? [] : [{ path, expected, actual }];
}

/** Renders one `FieldDiff` as a single human-readable line. */
export function formatDiff(diff: FieldDiff): string {
  const label = diff.path === '' ? '(root)' : diff.path;
  if (diff.actual === undefined) {
    return `${label}: expected ${formatValue(diff.expected!)}, missing`;
  }
  if (diff.expected === undefined) return `${label}: unexpected ${formatValue(diff.actual)}`;
  return `${label}: expected ${formatValue(diff.expected)}, got ${formatValue(diff.actual)}`;
}

export function formatDiffs(diffs: readonly FieldDiff[]): string {
  return diffs.map(formatDiff).join('\n');
}

/**
 * Converts any event into a plain `Value` for comparison: a `LogEvent`'s own fields as-is; a
 * `MetricEvent`/`SpanEvent` as a synthesized object mirroring the shape `@ferrule/operators`'s
 * `metric_to_log` transform produces for a metric (so the two are easy to keep in sync mentally)
 * and an analogous shape for a span. Testkit does not depend on `@ferrule/operators`; this is an
 * independent, intentionally similar mapping, not a shared implementation.
 */
export function eventToValue(event: Event): Value {
  if (event.kind === 'log') return event.fields;
  if (event.kind === 'metric') return metricToValue(event);
  return spanToValue(event);
}

function metricValueToValue(value: MetricEvent['value']): Value {
  const out: ValueMap = new Map();
  out.set('type', value.type);
  switch (value.type) {
    case 'counter':
    case 'gauge':
      out.set('value', value.value);
      break;
    case 'set':
      out.set('values', [...value.values]);
      break;
    case 'distribution':
      out.set('statistic', value.statistic);
      out.set(
        'samples',
        value.samples.map((s) => {
          const m: ValueMap = new Map();
          m.set('value', s.value);
          m.set('rate', s.rate);
          return m;
        }),
      );
      break;
    case 'histogram':
      out.set('count', BigInt(value.count));
      out.set('sum', value.sum);
      out.set(
        'buckets',
        value.buckets.map((b) => {
          const m: ValueMap = new Map();
          m.set('upper_limit', b.upperLimit);
          m.set('count', BigInt(b.count));
          return m;
        }),
      );
      break;
    case 'exponentialHistogram':
      out.set('scale', BigInt(value.scale));
      out.set('zero_count', BigInt(value.zeroCount));
      out.set('zero_threshold', value.zeroThreshold);
      out.set('positive', exponentialBucketsValue(value.positive));
      out.set('negative', exponentialBucketsValue(value.negative));
      out.set('count', BigInt(value.count));
      out.set('sum', value.sum);
      break;
    case 'summary':
      out.set('count', BigInt(value.count));
      out.set('sum', value.sum);
      out.set(
        'quantiles',
        value.quantiles.map((q) => {
          const m: ValueMap = new Map();
          m.set('quantile', q.quantile);
          m.set('value', q.value);
          return m;
        }),
      );
      break;
  }
  return out;
}

function exponentialBucketsValue(buckets: { offset: number; counts: number[] }): ValueMap {
  const m: ValueMap = new Map();
  m.set('offset', BigInt(buckets.offset));
  m.set(
    'counts',
    buckets.counts.map((c) => BigInt(c)),
  );
  return m;
}

function metricToValue(event: MetricEvent): Value {
  const out: ValueMap = new Map();
  out.set('name', event.name);
  if (event.series.namespace !== undefined) out.set('namespace', event.series.namespace);
  const tags: ValueMap = new Map();
  for (const [k, v] of event.tags) tags.set(k, v);
  out.set('tags', tags);
  out.set('kind', event.metricKind);
  out.set('value', metricValueToValue(event.value));
  return out;
}

function spanToValue(event: SpanEvent): Value {
  const out: ValueMap = new Map();
  out.set('trace_id', toHex(event.traceId));
  out.set('span_id', toHex(event.spanId));
  if (event.parentSpanId !== undefined) out.set('parent_span_id', toHex(event.parentSpanId));
  out.set('name', event.name);
  out.set('span_kind', event.spanKind);
  const status: ValueMap = new Map();
  status.set('code', event.status.code);
  if (event.status.message !== undefined) status.set('message', event.status.message);
  out.set('status', status);
  out.set('attributes', event.attributes);
  out.set('resource', event.resource);
  return out;
}
