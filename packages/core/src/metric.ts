import { ValueTypeError } from './errors.js';

/**
 * Whether a metric value is a change since the last report (`incremental`, e.g. StatsD
 * counters) or a current total/level (`absolute`, e.g. Prometheus scrapes).
 */
export type MetricKind = 'incremental' | 'absolute';

/** A weighted sample in a distribution. `rate` is the sampling rate inverse (1 = unsampled). */
export interface Sample {
  value: number;
  rate: number;
}

/** A histogram bucket. `count` is the number of observations in (previous upper, upperLimit]. */
export interface Bucket {
  upperLimit: number;
  count: number;
}

export interface Quantile {
  /** 0–1 */
  quantile: number;
  value: number;
}

export type MetricValue =
  | { type: 'counter'; value: number }
  | { type: 'gauge'; value: number }
  | { type: 'set'; values: Set<string> }
  | { type: 'distribution'; samples: Sample[]; statistic: 'histogram' | 'summary' }
  /**
   * Buckets are non-cumulative, sorted by `upperLimit`, and must not include `+Inf`: `count` is
   * the total number of observations, so observations above the last bucket are
   * `count - sum(bucket.count)`.
   */
  | { type: 'histogram'; buckets: Bucket[]; count: number; sum: number }
  | { type: 'summary'; quantiles: Quantile[]; count: number; sum: number };

export type MetricValueType = MetricValue['type'];

/** Identity of a metric time series. */
export interface MetricSeries {
  name: string;
  namespace?: string;
  tags: Map<string, string>;
}

export function cloneMetricValue(value: MetricValue): MetricValue {
  switch (value.type) {
    case 'counter':
    case 'gauge':
      return { ...value };
    case 'set':
      return { type: 'set', values: new Set(value.values) };
    case 'distribution':
      return { ...value, samples: value.samples.map((s) => ({ ...s })) };
    case 'histogram':
      return { ...value, buckets: value.buckets.map((b) => ({ ...b })) };
    case 'summary':
      return { ...value, quantiles: value.quantiles.map((q) => ({ ...q })) };
  }
}

export function cloneSeries(series: MetricSeries): MetricSeries {
  const copy: MetricSeries = { name: series.name, tags: new Map(series.tags) };
  if (series.namespace !== undefined) copy.namespace = series.namespace;
  return copy;
}

/**
 * A stable string key identifying a series, independent of tag insertion order. Components
 * are length-prefixed, so no choice of names or tag values can make two series collide.
 */
export function seriesKey(series: MetricSeries): string {
  const part = (s: string): string => `${s.length}:${s}`;
  let key = part(series.namespace ?? '') + part(series.name);
  const names = [...series.tags.keys()].sort();
  for (const name of names) key += part(name) + part(series.tags.get(name)!);
  return key;
}

/** True if two histograms share exactly the same bucket boundaries. */
export function sameBuckets(a: readonly Bucket[], b: readonly Bucket[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.upperLimit !== b[i]!.upperLimit) return false;
  }
  return true;
}

/** Whether {@link addMetricValues} can combine `a` and `b`. */
export function canAdd(a: MetricValue, b: MetricValue): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'histogram':
      return sameBuckets(a.buckets, (b as typeof a).buckets);
    case 'distribution':
      return a.statistic === (b as typeof a).statistic;
    case 'summary':
      return false;
    default:
      return true;
  }
}

/**
 * Combines two incremental values: counters and gauge deltas add, sets union, distributions
 * concatenate samples, histograms with identical buckets add bucket-wise. Returns a new value,
 * or `undefined` when the values cannot be combined (different types, different histogram
 * buckets, or summaries, whose quantiles are not additive).
 */
export function addMetricValues(a: MetricValue, b: MetricValue): MetricValue | undefined {
  if (!canAdd(a, b)) return undefined;
  switch (a.type) {
    case 'counter':
    case 'gauge':
      return { type: a.type, value: a.value + (b as typeof a).value };
    case 'set': {
      const values = new Set(a.values);
      for (const v of (b as typeof a).values) values.add(v);
      return { type: 'set', values };
    }
    case 'distribution':
      return {
        type: 'distribution',
        statistic: a.statistic,
        samples: [...a.samples, ...(b as typeof a).samples].map((s) => ({ ...s })),
      };
    case 'histogram': {
      const hb = b as typeof a;
      return {
        type: 'histogram',
        buckets: a.buckets.map((bucket, i) => ({
          upperLimit: bucket.upperLimit,
          count: bucket.count + hb.buckets[i]!.count,
        })),
        count: a.count + hb.count,
        sum: a.sum + hb.sum,
      };
    }
    case 'summary':
      return undefined;
  }
}

export type DeltaResult =
  | { kind: 'delta'; value: MetricValue }
  /** The series restarted (a counter went down); the current value is itself the delta. */
  | { kind: 'reset'; value: MetricValue }
  | { kind: 'incompatible' };

/**
 * Converts two consecutive absolute readings into an incremental value.
 *
 * - Counters and histograms: `current - previous`. If any component decreased, the source
 *   restarted and the current reading is returned as a `reset`.
 * - Gauges: the difference (which may be negative).
 * - Sets: the members present now but not before.
 * - Distributions and summaries have no meaningful difference and are `incompatible`.
 */
export function subtractMetricValues(current: MetricValue, previous: MetricValue): DeltaResult {
  if (current.type !== previous.type) return { kind: 'incompatible' };
  switch (current.type) {
    case 'counter': {
      const prev = (previous as typeof current).value;
      if (current.value < prev) return { kind: 'reset', value: cloneMetricValue(current) };
      return { kind: 'delta', value: { type: 'counter', value: current.value - prev } };
    }
    case 'gauge':
      return {
        kind: 'delta',
        value: { type: 'gauge', value: current.value - (previous as typeof current).value },
      };
    case 'set': {
      const prev = (previous as typeof current).values;
      const values = new Set<string>();
      for (const v of current.values) if (!prev.has(v)) values.add(v);
      return { kind: 'delta', value: { type: 'set', values } };
    }
    case 'histogram': {
      const prev = previous as typeof current;
      if (!sameBuckets(current.buckets, prev.buckets)) return { kind: 'incompatible' };
      const reset =
        current.count < prev.count ||
        current.buckets.some((bucket, i) => bucket.count < prev.buckets[i]!.count);
      if (reset) return { kind: 'reset', value: cloneMetricValue(current) };
      return {
        kind: 'delta',
        value: {
          type: 'histogram',
          buckets: current.buckets.map((bucket, i) => ({
            upperLimit: bucket.upperLimit,
            count: bucket.count - prev.buckets[i]!.count,
          })),
          count: current.count - prev.count,
          sum: current.sum - prev.sum,
        },
      };
    }
    case 'distribution':
    case 'summary':
      return { kind: 'incompatible' };
  }
}

/** A value of the same shape representing "no observations". */
export function zeroMetricValue(value: MetricValue): MetricValue {
  switch (value.type) {
    case 'counter':
    case 'gauge':
      return { type: value.type, value: 0 };
    case 'set':
      return { type: 'set', values: new Set() };
    case 'distribution':
      return { type: 'distribution', statistic: value.statistic, samples: [] };
    case 'histogram':
      return {
        type: 'histogram',
        buckets: value.buckets.map((b) => ({ upperLimit: b.upperLimit, count: 0 })),
        count: 0,
        sum: 0,
      };
    case 'summary':
      return {
        type: 'summary',
        quantiles: value.quantiles.map((q) => ({ ...q, value: 0 })),
        count: 0,
        sum: 0,
      };
  }
}

/**
 * Builds a histogram from distribution samples using the given (sorted, finite) upper bounds.
 * Sample rates act as weights.
 */
export function samplesToHistogram(
  samples: readonly Sample[],
  upperLimits: readonly number[],
): Extract<MetricValue, { type: 'histogram' }> {
  validateBounds(upperLimits);
  const buckets = upperLimits.map((upperLimit) => ({ upperLimit, count: 0 }));
  let count = 0;
  let sum = 0;
  for (const { value, rate } of samples) {
    const weight = rate > 0 ? rate : 1;
    count += weight;
    sum += value * weight;
    const i = lowerBound(upperLimits, value);
    if (i < buckets.length) buckets[i]!.count += weight;
  }
  return { type: 'histogram', buckets, count, sum };
}

/**
 * Estimates quantile `q` (0–1) of a histogram by linear interpolation within the bucket that
 * contains the target rank, assuming observations are spread evenly within each bucket. The
 * first bucket's lower edge is taken as 0 when its upper limit is positive. Returns `NaN` for an
 * empty histogram, and the highest finite bound when the rank falls above the last bucket.
 */
export function histogramQuantile(
  histogram: Extract<MetricValue, { type: 'histogram' }>,
  q: number,
): number {
  if (!(q >= 0 && q <= 1)) throw new ValueTypeError(`quantile must be within [0, 1], got ${q}`);
  const { buckets, count } = histogram;
  if (count <= 0 || buckets.length === 0) return NaN;
  const rank = q * count;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i]!;
    const next = cumulative + bucket.count;
    if (next >= rank && bucket.count > 0) {
      const lower = i === 0 ? Math.min(0, bucket.upperLimit) : buckets[i - 1]!.upperLimit;
      return lower + (bucket.upperLimit - lower) * ((rank - cumulative) / bucket.count);
    }
    cumulative = next;
  }
  return buckets[buckets.length - 1]!.upperLimit;
}

/**
 * Computes exact quantiles from weighted samples (nearest-rank on the weighted distribution),
 * for converting a distribution into a summary.
 */
export function samplesToSummary(
  samples: readonly Sample[],
  quantiles: readonly number[],
): Extract<MetricValue, { type: 'summary' }> {
  const sorted = samples
    .map((s) => ({ value: s.value, weight: s.rate > 0 ? s.rate : 1 }))
    .sort((a, b) => a.value - b.value);
  let count = 0;
  let sum = 0;
  for (const s of sorted) {
    count += s.weight;
    sum += s.value * s.weight;
  }
  const result: Quantile[] = quantiles.map((quantile) => {
    if (!(quantile >= 0 && quantile <= 1)) {
      throw new ValueTypeError(`quantile must be within [0, 1], got ${quantile}`);
    }
    if (sorted.length === 0) return { quantile, value: NaN };
    const target = Math.max(quantile * count, Number.MIN_VALUE);
    let cumulative = 0;
    for (const s of sorted) {
      cumulative += s.weight;
      if (cumulative >= target) return { quantile, value: s.value };
    }
    return { quantile, value: sorted[sorted.length - 1]!.value };
  });
  return { type: 'summary', quantiles: result, count, sum };
}

function validateBounds(upperLimits: readonly number[]): void {
  for (let i = 0; i < upperLimits.length; i++) {
    const b = upperLimits[i]!;
    if (!Number.isFinite(b)) throw new ValueTypeError('histogram bounds must be finite');
    if (i > 0 && b <= upperLimits[i - 1]!) {
      throw new ValueTypeError('histogram bounds must be strictly increasing');
    }
  }
}

/** Index of the first bound ≥ value (bucket upper limits are inclusive). */
function lowerBound(bounds: readonly number[], value: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bounds[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Default bucket bounds, in seconds, suitable for request latencies. */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);
