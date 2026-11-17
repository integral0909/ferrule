/**
 * The field shape a Ferrule Script program sees when it runs against a `MetricEvent`
 * (`target: 'metric'`, see `compile/program.ts`).
 *
 * Unlike a log event — whose fields are an arbitrary `ValueMap` and therefore type as `any`
 * unless the transform declares an `inputSchema` (design.md §3) — a metric event has a fixed,
 * known shape. So the metric target types every path from this schema instead, and the checker
 * treats the top level as **closed**: `.nmae` is a compile-time error with a did-you-mean, rather
 * than silently typing as `null` the way an unknown field of a closed log schema does. That is the
 * whole reason a program declares which kind it runs against at compile time: one compiled program
 * cannot serve both shapes.
 *
 * Field names mirror `metric_to_log`'s projection in `@ferrule/operators`, so the two
 * representations of a metric agree (`upper_limit`, `interval_ms`, ...).
 *
 * Value-shaped fields (`value`, `values`, `samples`, ...) only exist for some `MetricValue`
 * types, so each is typed `T | null`: reading one that does not apply to this metric yields
 * `null`, and a script narrows with the language's own `is` tests (`if .value is float { ... }`).
 * Writing one that does not apply aborts the event — see `runtime/metricAccess.ts`.
 */

import {
  arrayType,
  floatType,
  intType,
  nullType,
  objectType,
  stringType,
  timestampType,
  unionType,
  type Type,
} from './types.js';

/** Every top-level path a metric script may name, in documentation order. */
export const METRIC_FIELD_NAMES = Object.freeze([
  'name',
  'namespace',
  'tags',
  'kind',
  'type',
  'timestamp',
  'interval_ms',
  'value',
  'values',
  'samples',
  'statistic',
  'buckets',
  'count',
  'sum',
  'quantiles',
] as const);

export type MetricFieldName = (typeof METRIC_FIELD_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set<string>(METRIC_FIELD_NAMES);

export function isMetricFieldName(name: string): name is MetricFieldName {
  return NAME_SET.has(name);
}

/**
 * Fields a script may not assign to. `type` is read-only because changing it would mean rebuilding
 * the whole `MetricValue` — a script that wants a different metric type should `emit` a new metric
 * (a later milestone) or use the `log_to_metric`/`metric_to_log` transforms.
 */
export const READONLY_METRIC_FIELDS: ReadonlySet<string> = new Set(['type']);

/** Which value-shaped fields apply to each `MetricValue` type. */
export const METRIC_VALUE_FIELDS: Readonly<Record<string, readonly MetricFieldName[]>> =
  Object.freeze({
    counter: Object.freeze(['value'] as const),
    gauge: Object.freeze(['value'] as const),
    set: Object.freeze(['values'] as const),
    distribution: Object.freeze(['samples', 'statistic'] as const),
    histogram: Object.freeze(['buckets', 'count', 'sum'] as const),
    summary: Object.freeze(['quantiles', 'count', 'sum'] as const),
  });

/** Fields that exist on every metric regardless of its value type. */
export const METRIC_COMMON_FIELDS: readonly MetricFieldName[] = Object.freeze([
  'name',
  'namespace',
  'tags',
  'kind',
  'type',
  'timestamp',
  'interval_ms',
] as const);

function nullable(type: Type): Type {
  return unionType([type, nullType]);
}

const sampleType = objectType({ value: floatType, rate: floatType });
const bucketType = objectType({ upper_limit: floatType, count: floatType });
const quantileType = objectType({ quantile: floatType, value: floatType });

/** The closed object type the checker resolves metric paths against. */
export const metricEventSchema: Type = objectType({
  name: stringType,
  namespace: nullable(stringType),
  // `..string | null`: a tag that is not set reads as `null`, and assigning `null` (like
  // `del(.tags.host)`) removes it — see `runtime/metricAccess.ts`.
  tags: objectType({}, nullable(stringType)),
  kind: stringType,
  type: stringType,
  timestamp: nullable(timestampType),
  interval_ms: nullable(intType),
  value: nullable(floatType),
  values: nullable(arrayType(stringType)),
  samples: nullable(arrayType(sampleType)),
  statistic: nullable(stringType),
  buckets: nullable(arrayType(bucketType)),
  count: nullable(floatType),
  sum: nullable(floatType),
  quantiles: nullable(arrayType(quantileType)),
});
