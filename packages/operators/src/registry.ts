import type { TransformDefinition } from '@ferrule/runtime';
import { aggregateTransform } from './aggregate.js';
import { cardinalityLimitTransform } from './cardinality_limit.js';
import { dedupeTransform } from './dedupe.js';
import { filterTransform } from './filter.js';
import { logToMetricTransform } from './log_to_metric.js';
import { metricTagsTransform } from './metric_tags.js';
import { metricToLogTransform } from './metric_to_log.js';
import { remapFieldsTransform } from './remap_fields.js';
import { routeTransform } from './route.js';
import { sampleTransform } from './sample.js';
import { scriptTransform } from './script.js';
import { splitByKindTransform } from './split_by_kind.js';
import { tailSamplingTransform } from './tail_sampling.js';
import { throttleTransform } from './throttle.js';
import { windowReduceTransform } from './window_reduce.js';

/** Every transform this package provides, in a stable order, for registration or documentation. */
export function builtinOperators(): readonly TransformDefinition[] {
  return [
    scriptTransform,
    filterTransform,
    routeTransform,
    remapFieldsTransform,
    sampleTransform,
    throttleTransform,
    dedupeTransform,
    aggregateTransform,
    logToMetricTransform,
    metricToLogTransform,
    cardinalityLimitTransform,
    windowReduceTransform,
    tailSamplingTransform,
    splitByKindTransform,
    metricTagsTransform,
  ];
}
