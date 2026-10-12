import {
  arrayType,
  floatType,
  nullType,
  objectType,
  stringType,
  timestampType,
  unionType,
  type Type,
} from '../types/types.js';

/**
 * How a `MetricEvent` (`@ferrule/core`) appears to a Ferrule Script program — see
 * `docs/language/design.md`'s "Metric events" section for the full writeup; this module builds
 * the `Type` the checker types `.field` paths from (`check(program, { inputSchema:
 * metricEventSchema(), validateWrites: true, readonlyPaths: metricReadonlyPaths() })`), and
 * `metric/view.ts` builds/applies the matching runtime value.
 *
 * The view is **flat**, not nested under one `value` object the way
 * `packages/operators/src/metric_to_log.ts`'s log representation is: a Ferrule Script event path
 * (`.a.b`) is always one lexical token, resolved in a single pass by `check/checker.ts`'s
 * `pathType` (see design.md §2's "Path" token) — there is no `FieldAccessExpr` chaining into it
 * the way `x.a.b` on a local variable has. Nesting the per-type fields under one polymorphic
 * `.value` would make its declared type a union of five shapes, and the checker's field-access and
 * object-pattern logic (`checkField`/`checkObjectPattern`) only understands a concrete `object` or
 * `any` subject, not a union of objects — so `.value.count` would silently fall back to `any`
 * instead of being usefully typed. Giving every metric-value-type's field(s) their own top-level
 * name (`value`, `values`, `samples`/`statistic`, `buckets`/`count`/`sum`, `quantiles`/`count`/
 * `sum`) sidesteps that gap entirely: each name has one concrete type, period, and still reads as
 * "the value, under a typed field, varying by metric type" — a script just uses whichever
 * field(s) apply to the `.value_type` it's branching on (or declares a `.value_type` in a future
 * narrower view option, a known follow-up — see the module's "Known limitations" note below).
 *
 * `count`/`sum` are shared verbatim between `histogram` and `summary` (same name, same type in
 * both), which is why they appear once, not per-type.
 */

/** `{ value: float, rate: float }` — one weighted observation of a `distribution` metric. */
export const SAMPLE_SHAPE: Type = objectType({ value: floatType, rate: floatType });

/** `{ upper_limit: float, count: float }` — one non-cumulative bucket of a `histogram` metric. */
export const BUCKET_SHAPE: Type = objectType({ upper_limit: floatType, count: floatType });

/** `{ quantile: float, value: float }` — one estimated quantile of a `summary` metric. */
export const QUANTILE_SHAPE: Type = objectType({ quantile: floatType, value: floatType });

/**
 * The metric's value-type discriminator field: `"counter"`, `"gauge"`, `"set"`, `"distribution"`,
 * `"histogram"`, or `"summary"` (`@ferrule/core`'s `MetricValue['type']`). Readable but never
 * assignable (see {@link metricReadonlyPaths}) — changing a metric's value type isn't supported;
 * see `metric/view.ts`'s `applyViewToMetric` for the runtime half of that decision.
 */
export const METRIC_VALUE_TYPE_FIELD = 'value_type';

let cachedSchema: Type | undefined;

/**
 * The metric event's root object type, for `check`'s `inputSchema`. Closed (no `rest`): unlike a
 * log event, a metric has no backing store for an arbitrary extra field, so a name outside this
 * set is a compile-time "no such field" error (`resolveWritePathType` in `check/checker.ts`) on a
 * write, and reads as `null` (same permissiveness `pathType` already gives an unknown path) on a
 * read. `tags`, by contrast, *is* open within itself (`rest: string`) — matching
 * `MetricSeries.tags: Map<string, string>` — so `.tags.<anything> = 1` is a compile-time type
 * error regardless of the metric's value type (ferrule/ferrule#12's acceptance example), while
 * `.tags.env = "prod"` is fine.
 *
 * Every value-type's own field(s) coexist in this one schema (see the module doc for why); a
 * script that reads or writes a field that doesn't apply to the event's actual `.value_type` gets
 * `null` back (an absent path reads as `null`, same as any other schema) for a read, or has the
 * write validated against the event's real type only when the program finishes running — seeing
 * `null`/a stale value for a field that doesn't apply, right up until that point, is this view's
 * one notable soundness gap, on par with design.md's existing "a declared `input_schema` that
 * doesn't match the real data" tradeoff for logs.
 */
export function metricEventSchema(): Type {
  if (cachedSchema === undefined) {
    cachedSchema = objectType({
      name: stringType,
      namespace: unionType([stringType, nullType]),
      tags: objectType({}, stringType),
      kind: stringType,
      [METRIC_VALUE_TYPE_FIELD]: stringType,
      timestamp: unionType([timestampType, nullType]),
      interval_ms: unionType([floatType, nullType]),
      value: floatType,
      values: arrayType(stringType),
      statistic: stringType,
      samples: arrayType(SAMPLE_SHAPE),
      buckets: arrayType(BUCKET_SHAPE),
      count: floatType,
      sum: floatType,
      quantiles: arrayType(QUANTILE_SHAPE),
    });
  }
  return cachedSchema;
}

/**
 * Top-level metric fields a program can read but never assign, for `CheckOptions.readonlyPaths`.
 * Currently just the value-type discriminator — see {@link METRIC_VALUE_TYPE_FIELD}'s doc.
 */
export function metricReadonlyPaths(): ReadonlyMap<string, string> {
  return new Map([
    [
      METRIC_VALUE_TYPE_FIELD,
      `cannot assign to '.${METRIC_VALUE_TYPE_FIELD}': changing a metric's value type is not ` +
        'supported; derive a new metric instead (e.g. with a separate `log_to_metric`/`script` ' +
        'step) rather than reinterpreting this one',
    ],
  ]);
}
