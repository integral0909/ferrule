/**
 * `@ferrule/operators` — built-in Ferrule transforms that don't need Ferrule Script: field
 * remapping, sampling, throttling, deduplication, metric aggregation, log/metric conversion,
 * cardinality limiting, log windowing, trace tail sampling, event-kind splitting, and metric tag
 * helpers. See `README.md` for the full reference and YAML examples.
 */

export { aggregateOptions, aggregateTransform, type AggregateOptions } from './aggregate.js';
export {
  cardinalityLimitOptions,
  cardinalityLimitTransform,
  type CardinalityLimitOptions,
} from './cardinality_limit.js';
export { dedupeOptions, dedupeTransform, type DedupeOptions } from './dedupe.js';
export {
  logToMetricOptions,
  logToMetricTransform,
  type LogToMetricOptions,
  type MetricSpec,
} from './log_to_metric.js';
export { metricTagsOptions, metricTagsTransform, type MetricTagsOptions } from './metric_tags.js';
export {
  metricToLogOptions,
  metricToLogTransform,
  type MetricToLogOptions,
} from './metric_to_log.js';
export {
  remapFieldsOptions,
  remapFieldsTransform,
  type RemapFieldsOptions,
  type RemapOperation,
} from './remap_fields.js';
export { sampleOptions, sampleTransform, type SampleOptions } from './sample.js';
export {
  splitByKindOptions,
  splitByKindTransform,
  type SplitByKindOptions,
} from './split_by_kind.js';
export {
  tailSamplingOptions,
  tailSamplingTransform,
  type TailSamplingOptions,
  type TailSamplingPolicy,
} from './tail_sampling.js';
export { throttleOptions, throttleTransform, type ThrottleOptions } from './throttle.js';
export {
  windowReduceOptions,
  windowReduceTransform,
  type WindowReduceOptions,
} from './window_reduce.js';

export { builtinOperators } from './registry.js';

export {
  conditionSchema,
  evaluateCondition,
  type ConditionSpec,
  type FieldGetter,
} from './util/condition.js';
export { compileTemplate, valueToTemplateText, type Template } from './util/template.js';
export { BloomFilter } from './util/bloom.js';
export { LruCache, TtlLruCache } from './util/lru.js';
export { TokenBucket, refillRatePerMs } from './util/token-bucket.js';
export {
  fingerprintFields,
  fingerprintValue,
  hashString,
  hashBytes,
  unitInterval,
} from './util/hash.js';
export { coerceValue, toNumber, type CoerceTarget, type TimestampFormat } from './util/coerce.js';
export { getEventField } from './util/fields.js';
