import { LimitExceededError, ValueTypeError } from './errors.js';

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

/**
 * One side (positive or negative) of an exponential histogram's sparse bucket list: bucket at
 * absolute index `offset + i` holds `counts[i]`. See the `exponentialHistogram` variant of
 * {@link MetricValue} for the bucket index convention.
 */
export interface ExponentialBuckets {
  offset: number;
  counts: number[];
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
  /**
   * A lossless exponential-bucket histogram (OTLP's `ExponentialHistogram`): bucket boundaries
   * are derived from `scale` rather than stored explicitly, trading a fixed growth factor for
   * much finer resolution per byte than {@link Bucket}[]. `base = 2 ** (2 ** -scale)`; relative
   * to each side's own `offset`, bucket `i` of `positive` covers `(base ** i, base ** (i + 1)]`
   * and bucket `i` of `negative` covers the mirror image, `[-(base ** (i + 1)), -(base ** i))`.
   * A value with `|v| <= zeroThreshold` is counted in `zeroCount` instead of either range.
   * `count` is the total number of observations and `sum` their total, exactly as for
   * {@link Bucket}-based histograms. See {@link addMetricValues}/{@link subtractMetricValues}
   * for how two histograms at different scales are reconciled, and
   * {@link exponentialHistogramToHistogram} for converting to explicit buckets at an edge that
   * cannot represent an exponential scale (Prometheus, StatsD).
   */
  | {
      type: 'exponentialHistogram';
      scale: number;
      zeroCount: number;
      zeroThreshold: number;
      positive: ExponentialBuckets;
      negative: ExponentialBuckets;
      count: number;
      sum: number;
    }
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
    case 'exponentialHistogram':
      return {
        ...value,
        positive: cloneExponentialBuckets(value.positive),
        negative: cloneExponentialBuckets(value.negative),
      };
    case 'summary':
      return { ...value, quantiles: value.quantiles.map((q) => ({ ...q })) };
  }
}

function cloneExponentialBuckets(buckets: ExponentialBuckets): ExponentialBuckets {
  return { offset: buckets.offset, counts: [...buckets.counts] };
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

/** `base = 2 ** (2 ** -scale)`, the per-bucket growth factor of an exponential histogram at a
 * given scale (see the `exponentialHistogram` variant of {@link MetricValue}). */
export function exponentialHistogramBase(scale: number): number {
  return Math.pow(2, Math.pow(2, -scale));
}

/** Upper bound on the number of buckets a single downscale/merge/subtract of exponential
 * histogram buckets may materialize, guarding against a pathological pair of `offset`s (each
 * individually bounded on decode, but arbitrarily far apart) forcing an unbounded allocation. */
const MAX_EXPONENTIAL_HISTOGRAM_SPAN = 1 << 20;

function exponentialHistogramSpanError(action: string): never {
  throw new LimitExceededError(
    'metric.exponentialHistogram.span',
    MAX_EXPONENTIAL_HISTOGRAM_SPAN,
    `${action} these exponential histogram buckets would allocate too many buckets`,
  );
}

/** Shifts every bucket index right by `shift` (merging `2 ** shift` adjacent buckets into one),
 * the operation that reconciles two exponential histograms recorded at different scales: scale
 * decreases by `shift` while the value range each bucket covers grows by the same factor. */
function downscaleExponentialBuckets(
  buckets: ExponentialBuckets,
  shift: number,
): ExponentialBuckets {
  if (shift <= 0 || buckets.counts.length === 0) return buckets;
  if (shift >= 32) {
    const total = buckets.counts.reduce((sum, c) => sum + c, 0);
    return total === 0 ? { offset: 0, counts: [] } : { offset: 0, counts: [total] };
  }
  const newOffset = buckets.offset >> shift;
  const lastOldIndex = buckets.offset + buckets.counts.length - 1;
  const span = (lastOldIndex >> shift) - newOffset + 1;
  if (span > MAX_EXPONENTIAL_HISTOGRAM_SPAN) exponentialHistogramSpanError('downscaling');
  const counts = new Array<number>(span).fill(0);
  for (let i = 0; i < buckets.counts.length; i++) {
    const oldIndex = buckets.offset + i;
    counts[(oldIndex >> shift) - newOffset]! += buckets.counts[i]!;
  }
  return { offset: newOffset, counts };
}

interface AlignedExponentialHistogram {
  scale: number;
  zeroCount: number;
  zeroThreshold: number;
  positive: ExponentialBuckets;
  negative: ExponentialBuckets;
}

/** Downscales `value` to `scale` (which must be `<= value.scale`), the first step of reconciling
 * two exponential histograms recorded at different scales before merging or subtracting them. */
function alignExponentialHistogram(
  value: Extract<MetricValue, { type: 'exponentialHistogram' }>,
  scale: number,
): AlignedExponentialHistogram {
  const shift = value.scale - scale;
  return {
    scale,
    zeroCount: value.zeroCount,
    zeroThreshold: value.zeroThreshold,
    positive: downscaleExponentialBuckets(value.positive, shift),
    negative: downscaleExponentialBuckets(value.negative, shift),
  };
}

/** Moves the leading run of buckets entirely within `[-threshold, threshold]` (the buckets
 * closest to zero, since bucket value ranges grow with index) out of `buckets` and into a
 * returned count, for reconciling two differing `zeroThreshold`s before combining two
 * exponential histograms: once the wider of the two thresholds is chosen, any bucket it newly
 * covers has to stop being counted on its own. */
function foldExponentialZeroThreshold(
  buckets: ExponentialBuckets,
  scale: number,
  threshold: number,
): { buckets: ExponentialBuckets; folded: number } {
  if (threshold <= 0 || buckets.counts.length === 0) return { buckets, folded: 0 };
  const base = exponentialHistogramBase(scale);
  let i = 0;
  let folded = 0;
  while (i < buckets.counts.length && Math.pow(base, buckets.offset + i + 1) <= threshold) {
    folded += buckets.counts[i]!;
    i++;
  }
  if (i === 0) return { buckets, folded: 0 };
  return { buckets: { offset: buckets.offset + i, counts: buckets.counts.slice(i) }, folded };
}

interface ReconciledExponentialHistograms {
  threshold: number;
  aZeroCount: number;
  bZeroCount: number;
  aPositive: ExponentialBuckets;
  aNegative: ExponentialBuckets;
  bPositive: ExponentialBuckets;
  bNegative: ExponentialBuckets;
}

/** Aligns two already-same-scale exponential histograms to a common `zeroThreshold` (the wider
 * of the two), folding any bucket the new threshold newly covers into each side's zero count. */
function reconcileExponentialZeroThresholds(
  a: AlignedExponentialHistogram,
  b: AlignedExponentialHistogram,
): ReconciledExponentialHistograms {
  const threshold = Math.max(a.zeroThreshold, b.zeroThreshold);
  const aPos = foldExponentialZeroThreshold(a.positive, a.scale, threshold);
  const aNeg = foldExponentialZeroThreshold(a.negative, a.scale, threshold);
  const bPos = foldExponentialZeroThreshold(b.positive, b.scale, threshold);
  const bNeg = foldExponentialZeroThreshold(b.negative, b.scale, threshold);
  return {
    threshold,
    aZeroCount: a.zeroCount + aPos.folded + aNeg.folded,
    bZeroCount: b.zeroCount + bPos.folded + bNeg.folded,
    aPositive: aPos.buckets,
    aNegative: aNeg.buckets,
    bPositive: bPos.buckets,
    bNegative: bNeg.buckets,
  };
}

/** Sums two same-scale exponential bucket lists index-wise, aligning their (possibly different)
 * offsets first. */
function mergeExponentialBuckets(a: ExponentialBuckets, b: ExponentialBuckets): ExponentialBuckets {
  if (a.counts.length === 0) return b;
  if (b.counts.length === 0) return a;
  const offset = Math.min(a.offset, b.offset);
  const lastIndex = Math.max(a.offset + a.counts.length - 1, b.offset + b.counts.length - 1);
  const span = lastIndex - offset + 1;
  if (span > MAX_EXPONENTIAL_HISTOGRAM_SPAN) exponentialHistogramSpanError('merging');
  const counts = new Array<number>(span).fill(0);
  for (let i = 0; i < a.counts.length; i++) counts[a.offset + i - offset]! += a.counts[i]!;
  for (let i = 0; i < b.counts.length; i++) counts[b.offset + i - offset]! += b.counts[i]!;
  return { offset, counts };
}

/** Subtracts `previous` from `current` index-wise (aligning offsets first), returning
 * `undefined` if any resulting bucket would go negative (the series restarted). Trims leading
 * and trailing all-zero buckets so a fully-cancelled range collapses to an empty bucket list. */
function subtractExponentialBuckets(
  current: ExponentialBuckets,
  previous: ExponentialBuckets,
): ExponentialBuckets | undefined {
  if (previous.counts.length === 0) return current;
  if (current.counts.length === 0) {
    return previous.counts.every((c) => c === 0) ? current : undefined;
  }
  const offset = Math.min(current.offset, previous.offset);
  const lastIndex = Math.max(
    current.offset + current.counts.length - 1,
    previous.offset + previous.counts.length - 1,
  );
  const span = lastIndex - offset + 1;
  if (span > MAX_EXPONENTIAL_HISTOGRAM_SPAN) exponentialHistogramSpanError('subtracting');
  const counts = new Array<number>(span).fill(0);
  for (let i = 0; i < current.counts.length; i++) {
    counts[current.offset + i - offset]! += current.counts[i]!;
  }
  for (let i = 0; i < previous.counts.length; i++) {
    counts[previous.offset + i - offset]! -= previous.counts[i]!;
  }
  for (const c of counts) if (c < 0) return undefined;
  let start = 0;
  while (start < counts.length && counts[start] === 0) start++;
  let end = counts.length;
  while (end > start && counts[end - 1] === 0) end--;
  return { offset: offset + start, counts: counts.slice(start, end) };
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
 * concatenate samples, histograms with identical buckets add bucket-wise, exponential histograms
 * add after downscaling both to the coarser of their two scales (and widening to the larger of
 * their two `zeroThreshold`s). Returns a new value, or `undefined` when the values cannot be
 * combined (different types, different histogram buckets, or summaries, whose quantiles are not
 * additive). Throws `LimitExceededError` if the two exponential histograms' bucket offsets are so
 * far apart that aligning them would allocate an unreasonable number of buckets.
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
    case 'exponentialHistogram': {
      const hb = b as typeof a;
      const scale = Math.min(a.scale, hb.scale);
      const r = reconcileExponentialZeroThresholds(
        alignExponentialHistogram(a, scale),
        alignExponentialHistogram(hb, scale),
      );
      return {
        type: 'exponentialHistogram',
        scale,
        zeroThreshold: r.threshold,
        zeroCount: r.aZeroCount + r.bZeroCount,
        positive: mergeExponentialBuckets(r.aPositive, r.bPositive),
        negative: mergeExponentialBuckets(r.aNegative, r.bNegative),
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
 * - Exponential histograms: like histograms, but `current` and `previous` are first aligned to
 *   the coarser of their two scales and the wider of their two `zeroThreshold`s (see
 *   {@link addMetricValues}); a bucket that goes negative after alignment is treated the same as
 *   a reset.
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
    case 'exponentialHistogram': {
      const prev = previous as typeof current;
      const scale = Math.min(current.scale, prev.scale);
      const r = reconcileExponentialZeroThresholds(
        alignExponentialHistogram(current, scale),
        alignExponentialHistogram(prev, scale),
      );
      if (r.aZeroCount < r.bZeroCount || current.count < prev.count) {
        return { kind: 'reset', value: cloneMetricValue(current) };
      }
      const positive = subtractExponentialBuckets(r.aPositive, r.bPositive);
      const negative =
        positive === undefined ? undefined : subtractExponentialBuckets(r.aNegative, r.bNegative);
      if (positive === undefined || negative === undefined) {
        return { kind: 'reset', value: cloneMetricValue(current) };
      }
      return {
        kind: 'delta',
        value: {
          type: 'exponentialHistogram',
          scale,
          zeroThreshold: r.threshold,
          zeroCount: r.aZeroCount - r.bZeroCount,
          positive,
          negative,
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
    case 'exponentialHistogram':
      return {
        type: 'exponentialHistogram',
        scale: value.scale,
        zeroThreshold: value.zeroThreshold,
        zeroCount: 0,
        positive: { offset: value.positive.offset, counts: value.positive.counts.map(() => 0) },
        negative: { offset: value.negative.offset, counts: value.negative.counts.map(() => 0) },
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
 * Converts a lossless `exponentialHistogram` {@link MetricValue} into an equivalent explicit-
 * bucket `histogram`, for sinks that cannot represent an exponential scale (Prometheus, StatsD,
 * Prometheus remote write). Positive bucket `i` (covering `(base ** i, base ** (i + 1)]`)
 * becomes a bucket at `upperLimit = base ** (i + 1)`; negative buckets mirror this
 * (`upperLimit = -(base ** i)`), emitted from the most-negative index down to the least so the
 * result is ascending by `upperLimit`; the zero bucket (if `zeroCount > 0`) becomes one more
 * bucket at `upperLimit = zeroThreshold`. This conversion is lossy — it throws away the
 * exponential scale — and has no inverse. Throws `ValueTypeError` if an extreme `scale`/`offset`
 * combination would produce a non-finite bucket boundary.
 */
export function exponentialHistogramToHistogram(
  value: Extract<MetricValue, { type: 'exponentialHistogram' }>,
): Extract<MetricValue, { type: 'histogram' }> {
  const base = exponentialHistogramBase(value.scale);
  const buckets: Bucket[] = [];
  const { negative, positive } = value;
  for (let i = negative.counts.length - 1; i >= 0; i--) {
    const index = negative.offset + i;
    buckets.push({
      upperLimit: finiteExponentialBound(-Math.pow(base, index)),
      count: negative.counts[i]!,
    });
  }
  if (value.zeroCount > 0) {
    buckets.push({ upperLimit: value.zeroThreshold, count: value.zeroCount });
  }
  for (let i = 0; i < positive.counts.length; i++) {
    const index = positive.offset + i;
    buckets.push({
      upperLimit: finiteExponentialBound(Math.pow(base, index + 1)),
      count: positive.counts[i]!,
    });
  }
  return { type: 'histogram', buckets, count: value.count, sum: value.sum };
}

function finiteExponentialBound(n: number): number {
  if (!Number.isFinite(n)) {
    throw new ValueTypeError(
      'exponential histogram scale/offset produced a non-finite bucket boundary',
    );
  }
  return n;
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
