import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMetricValues,
  canAdd,
  cloneMetricValue,
  exponentialHistogramToHistogram,
  histogramQuantile,
  samplesToHistogram,
  samplesToSummary,
  seriesKey,
  subtractMetricValues,
  ValueTypeError,
  zeroMetricValue,
  type ExponentialBuckets,
  type MetricSeries,
  type MetricValue,
} from '@ferrule/core';

type Histogram = Extract<MetricValue, { type: 'histogram' }>;
type ExponentialHistogram = Extract<MetricValue, { type: 'exponentialHistogram' }>;

const histogram = (counts: number[], bounds = [1, 5, 10], sum = 0): Histogram => ({
  type: 'histogram',
  buckets: bounds.map((upperLimit, i) => ({ upperLimit, count: counts[i] ?? 0 })),
  count: counts.reduce((a, b) => a + b, 0),
  sum,
});

const expHistogram = (fields: {
  scale: number;
  positive?: ExponentialBuckets;
  negative?: ExponentialBuckets;
  zeroCount?: number;
  zeroThreshold?: number;
  count: number;
  sum: number;
}): ExponentialHistogram => ({
  type: 'exponentialHistogram',
  scale: fields.scale,
  zeroCount: fields.zeroCount ?? 0,
  zeroThreshold: fields.zeroThreshold ?? 0,
  positive: fields.positive ?? { offset: 0, counts: [] },
  negative: fields.negative ?? { offset: 0, counts: [] },
  count: fields.count,
  sum: fields.sum,
});

/** Index formula from the OTel exponential histogram spec: for `v > 0` at a given `scale`,
 * bucket index `i` covers `(base ** i, base ** (i + 1)]`, where `base = 2 ** (2 ** -scale)`. This
 * is the independent "direct binning" reference the merge property test below compares against —
 * downscaling and merging two histograms recorded at different scales must agree with binning
 * every raw observation directly at the coarser of the two scales. */
function exponentialIndexOf(value: number, scale: number): number {
  return Math.ceil(Math.log2(value) * Math.pow(2, scale)) - 1;
}

/** Builds an exponential histogram directly from positive samples at `scale` — the reference
 * implementation the merge/downscale logic in `addMetricValues` is checked against. */
function buildExponentialHistogram(
  samples: readonly number[],
  scale: number,
): ExponentialHistogram {
  const byIndex = new Map<number, number>();
  let sum = 0;
  for (const v of samples) {
    sum += v;
    const idx = exponentialIndexOf(v, scale);
    byIndex.set(idx, (byIndex.get(idx) ?? 0) + 1);
  }
  const indices = [...byIndex.keys()];
  const offset = indices.length === 0 ? 0 : Math.min(...indices);
  const maxIndex = indices.length === 0 ? -1 : Math.max(...indices);
  const counts = Array.from(
    { length: Math.max(0, maxIndex - offset + 1) },
    (_, i) => byIndex.get(offset + i) ?? 0,
  );
  return expHistogram({ scale, positive: { offset, counts }, count: samples.length, sum });
}

/** Collapses a sparse bucket list to `absoluteIndex -> count` (dropping zero entries), for
 * comparing two bucket lists that may differ in offset/trimming but agree on content. */
function toIndexMap(buckets: ExponentialBuckets): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < buckets.counts.length; i++) {
    if (buckets.counts[i] !== 0) map.set(buckets.offset + i, buckets.counts[i]!);
  }
  return map;
}

describe('seriesKey', () => {
  it('ignores tag insertion order', () => {
    const a = seriesKey({
      name: 'm',
      tags: new Map([
        ['x', '1'],
        ['y', '2'],
      ]),
    });
    const b = seriesKey({
      name: 'm',
      tags: new Map([
        ['y', '2'],
        ['x', '1'],
      ]),
    });
    expect(a).toBe(b);
  });

  it('cannot be forged by delimiter characters in names or values', () => {
    const a = seriesKey({ name: 'm', tags: new Map([['a', 'b1:c']]) });
    const b = seriesKey({
      name: 'm',
      tags: new Map([
        ['a', 'b'],
        ['c', ''],
      ]),
    });
    expect(a).not.toBe(b);
    expect(seriesKey({ name: 'ab', tags: new Map() })).not.toBe(
      seriesKey({ name: 'b', namespace: 'a', tags: new Map() }),
    );
  });

  it('is injective over generated series', () => {
    const arbSeries: fc.Arbitrary<MetricSeries> = fc
      .record({
        name: fc.string(),
        namespace: fc.option(fc.string(), { nil: undefined }),
        tags: fc.dictionary(fc.string(), fc.string()),
      })
      .map(({ name, namespace, tags }) => {
        const series: MetricSeries = { name, tags: new Map(Object.entries(tags)) };
        if (namespace !== undefined) series.namespace = namespace;
        return series;
      });
    fc.assert(
      fc.property(arbSeries, arbSeries, (a, b) => {
        const same =
          a.name === b.name &&
          (a.namespace ?? '') === (b.namespace ?? '') &&
          a.tags.size === b.tags.size &&
          [...a.tags].every(([k, v]) => b.tags.get(k) === v);
        expect(seriesKey(a) === seriesKey(b)).toBe(same);
      }),
    );
  });
});

describe('addMetricValues', () => {
  it('adds counters and gauge deltas', () => {
    expect(addMetricValues({ type: 'counter', value: 2 }, { type: 'counter', value: 3 })).toEqual({
      type: 'counter',
      value: 5,
    });
    expect(addMetricValues({ type: 'gauge', value: 2 }, { type: 'gauge', value: -3 })).toEqual({
      type: 'gauge',
      value: -1,
    });
  });

  it('unions sets without mutating inputs', () => {
    const a: MetricValue = { type: 'set', values: new Set(['x']) };
    const b: MetricValue = { type: 'set', values: new Set(['y', 'x']) };
    expect(addMetricValues(a, b)).toEqual({ type: 'set', values: new Set(['x', 'y']) });
    expect(a.values.size).toBe(1);
  });

  it('concatenates distribution samples of the same statistic', () => {
    const a: MetricValue = {
      type: 'distribution',
      statistic: 'histogram',
      samples: [{ value: 1, rate: 1 }],
    };
    const b: MetricValue = {
      type: 'distribution',
      statistic: 'histogram',
      samples: [{ value: 2, rate: 2 }],
    };
    expect(addMetricValues(a, b)).toEqual({
      type: 'distribution',
      statistic: 'histogram',
      samples: [
        { value: 1, rate: 1 },
        { value: 2, rate: 2 },
      ],
    });
    expect(addMetricValues(a, { ...b, statistic: 'summary' })).toBeUndefined();
  });

  it('adds histograms with the same buckets only', () => {
    expect(
      addMetricValues(histogram([1, 2, 3], undefined, 10), histogram([1, 0, 1], undefined, 5)),
    ).toEqual(histogram([2, 2, 4], undefined, 15));
    expect(addMetricValues(histogram([1]), histogram([1], [1, 5, 20]))).toBeUndefined();
  });

  it('refuses mismatched types and summaries', () => {
    expect(canAdd({ type: 'counter', value: 1 }, { type: 'gauge', value: 1 })).toBe(false);
    const summary: MetricValue = { type: 'summary', quantiles: [], count: 1, sum: 1 };
    expect(addMetricValues(summary, summary)).toBeUndefined();
  });
});

describe('subtractMetricValues', () => {
  it('computes counter deltas and detects resets', () => {
    expect(
      subtractMetricValues({ type: 'counter', value: 10 }, { type: 'counter', value: 4 }),
    ).toEqual({
      kind: 'delta',
      value: { type: 'counter', value: 6 },
    });
    expect(
      subtractMetricValues({ type: 'counter', value: 3 }, { type: 'counter', value: 4 }),
    ).toEqual({
      kind: 'reset',
      value: { type: 'counter', value: 3 },
    });
  });

  it('computes gauge and set differences', () => {
    expect(subtractMetricValues({ type: 'gauge', value: 1 }, { type: 'gauge', value: 4 })).toEqual({
      kind: 'delta',
      value: { type: 'gauge', value: -3 },
    });
    expect(
      subtractMetricValues(
        { type: 'set', values: new Set(['a', 'b']) },
        { type: 'set', values: new Set(['a']) },
      ),
    ).toEqual({ kind: 'delta', value: { type: 'set', values: new Set(['b']) } });
  });

  it('handles histograms: delta, reset, and incompatible buckets', () => {
    expect(
      subtractMetricValues(histogram([3, 3, 3], undefined, 9), histogram([1, 2, 3], undefined, 4)),
    ).toEqual({
      kind: 'delta',
      value: histogram([2, 1, 0], undefined, 5),
    });
    expect(subtractMetricValues(histogram([0, 3, 3]), histogram([1, 2, 3])).kind).toBe('reset');
    expect(subtractMetricValues(histogram([1]), histogram([1], [2, 3, 4])).kind).toBe(
      'incompatible',
    );
  });

  it('is the inverse of addition for counters', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (base, delta) => {
        const prev: MetricValue = { type: 'counter', value: base };
        const next = addMetricValues(prev, { type: 'counter', value: delta })!;
        expect(subtractMetricValues(next, prev)).toEqual({
          kind: 'delta',
          value: { type: 'counter', value: delta },
        });
      }),
    );
  });

  it('rejects types without a meaningful difference', () => {
    expect(
      subtractMetricValues({ type: 'counter', value: 1 }, { type: 'gauge', value: 1 }).kind,
    ).toBe('incompatible');
    const dist: MetricValue = { type: 'distribution', statistic: 'summary', samples: [] };
    expect(subtractMetricValues(dist, dist).kind).toBe('incompatible');
  });
});

describe('zeroMetricValue and cloneMetricValue', () => {
  it('produces empty values of the same shape', () => {
    expect(zeroMetricValue(histogram([1, 2, 3], undefined, 5))).toEqual(histogram([0, 0, 0]));
    expect(zeroMetricValue({ type: 'set', values: new Set(['a']) })).toEqual({
      type: 'set',
      values: new Set(),
    });
    expect(
      zeroMetricValue({
        type: 'summary',
        quantiles: [{ quantile: 0.5, value: 3 }],
        count: 1,
        sum: 3,
      }),
    ).toEqual({
      type: 'summary',
      quantiles: [{ quantile: 0.5, value: 0 }],
      count: 0,
      sum: 0,
    });
  });

  it('clones deeply', () => {
    const original = histogram([1, 2, 3]);
    const copy = cloneMetricValue(original) as Histogram;
    copy.buckets[0]!.count = 100;
    expect(original.buckets[0]!.count).toBe(1);
  });

  it('clones exponential histograms deeply and zeroes them independently', () => {
    const original = expHistogram({
      scale: 2,
      positive: { offset: -1, counts: [1, 2, 3] },
      negative: { offset: 0, counts: [4] },
      zeroCount: 5,
      count: 15,
      sum: 10,
    });
    const copy = cloneMetricValue(original) as ExponentialHistogram;
    copy.positive.counts[0] = 100;
    copy.negative.counts[0] = 100;
    expect(original.positive.counts[0]).toBe(1);
    expect(original.negative.counts[0]).toBe(4);

    const zero = zeroMetricValue(original) as ExponentialHistogram;
    expect(zero.scale).toBe(2);
    expect(zero.positive).toEqual({ offset: -1, counts: [0, 0, 0] });
    expect(zero.negative).toEqual({ offset: 0, counts: [0] });
    expect(zero.zeroCount).toBe(0);
    expect(zero.count).toBe(0);
    expect(zero.sum).toBe(0);
  });
});

describe('exponentialHistogram add/subtract', () => {
  it('adds two histograms at the same scale bucket-wise', () => {
    const a = expHistogram({
      scale: 1,
      positive: { offset: 0, counts: [1, 2] },
      negative: { offset: 0, counts: [1] },
      zeroCount: 2,
      count: 6,
      sum: 10,
    });
    const b = expHistogram({
      scale: 1,
      positive: { offset: 1, counts: [10] },
      zeroCount: 1,
      count: 11,
      sum: 5,
    });
    const sum = addMetricValues(a, b) as ExponentialHistogram;
    expect(sum.scale).toBe(1);
    expect(sum.zeroCount).toBe(3);
    expect(sum.count).toBe(17);
    expect(sum.sum).toBe(15);
    // a.positive index 0 -> 1, index 1 -> 2; b.positive index 1 -> 10 => merged index1 = 12.
    expect(toIndexMap(sum.positive)).toEqual(
      new Map([
        [0, 1],
        [1, 12],
      ]),
    );
    expect(toIndexMap(sum.negative)).toEqual(new Map([[0, 1]]));
  });

  it('downscales the finer histogram before merging two different scales', () => {
    // At scale 1, base = 2^(2^-1) = sqrt(2) ≈ 1.41421; bucket 0 covers (1, 1.41421] and bucket 1
    // covers (1.41421, 2] — together exactly (1, 2]. At scale 0, base = 2, and bucket 0 covers
    // that same (1, 2]. Downscaling scale 1 -> 0 is shift = 1, so fine indices 0 and 1 both
    // collapse into coarse index 0 (0 >> 1 === 0 and 1 >> 1 === 0), matching that range exactly.
    const fine = expHistogram({
      scale: 1,
      positive: { offset: 0, counts: [3, 4] },
      count: 7,
      sum: 7,
    });
    const coarse = expHistogram({
      scale: 0,
      positive: { offset: 0, counts: [5] },
      count: 5,
      sum: 5,
    });
    const merged = addMetricValues(fine, coarse) as ExponentialHistogram;
    expect(merged.scale).toBe(0);
    expect(merged.count).toBe(12);
    expect(toIndexMap(merged.positive)).toEqual(new Map([[0, 3 + 4 + 5]]));
  });

  it('merging at different scales matches direct binning at the coarser scale (reference)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true }), {
          maxLength: 15,
        }),
        fc.array(fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true }), {
          maxLength: 15,
        }),
        fc.integer({ min: -4, max: 4 }),
        fc.integer({ min: -4, max: 4 }),
        (samplesA, samplesB, scaleA, scaleB) => {
          const a = buildExponentialHistogram(samplesA, scaleA);
          const b = buildExponentialHistogram(samplesB, scaleB);
          const merged = addMetricValues(a, b) as ExponentialHistogram;
          const scale = Math.min(scaleA, scaleB);
          const reference = buildExponentialHistogram([...samplesA, ...samplesB], scale);

          expect(merged.scale).toBe(scale);
          expect(merged.count).toBe(reference.count);
          expect(merged.sum).toBeCloseTo(reference.sum, 6);
          expect(toIndexMap(merged.positive)).toEqual(toIndexMap(reference.positive));
        },
      ),
    );
  });

  it('reconciles different zero thresholds by widening and folding covered buckets in', () => {
    // scale 0: base = 2, bucket 0 covers (1, 2] — entirely within a zero threshold of 2.
    const a = expHistogram({
      scale: 0,
      positive: { offset: 0, counts: [7] },
      zeroCount: 1,
      zeroThreshold: 0,
      count: 8,
      sum: 10,
    });
    const b = expHistogram({
      scale: 0,
      zeroCount: 2,
      zeroThreshold: 2,
      count: 2,
      sum: 0,
    });
    const merged = addMetricValues(a, b) as ExponentialHistogram;
    expect(merged.zeroThreshold).toBe(2);
    expect(merged.zeroCount).toBe(1 + 7 + 2);
    expect(toIndexMap(merged.positive).size).toBe(0);
  });

  it('computes a delta between two absolute readings and detects resets', () => {
    const prev = expHistogram({
      scale: 0,
      positive: { offset: 0, counts: [2, 3] },
      zeroCount: 1,
      count: 6,
      sum: 5,
    });
    const current = expHistogram({
      scale: 0,
      positive: { offset: 0, counts: [5, 3] },
      zeroCount: 2,
      count: 10,
      sum: 9,
    });
    const delta = subtractMetricValues(current, prev);
    expect(delta.kind).toBe('delta');
    const value = delta.value as ExponentialHistogram;
    expect(value.count).toBe(4);
    expect(value.sum).toBe(4);
    expect(value.zeroCount).toBe(1);
    expect(toIndexMap(value.positive)).toEqual(new Map([[0, 3]]));

    const reset = subtractMetricValues(prev, current);
    expect(reset.kind).toBe('reset');
  });
});

describe('exponentialHistogramToHistogram', () => {
  it('expands positive-only buckets to ascending explicit upper limits', () => {
    const value = expHistogram({
      scale: 0, // base = 2
      positive: { offset: 0, counts: [3, 5, 2] },
      count: 10,
      sum: 42,
    });
    const hist = exponentialHistogramToHistogram(value);
    expect(hist.buckets.map((b) => b.upperLimit)).toEqual([2, 4, 8]);
    expect(hist.buckets.map((b) => b.count)).toEqual([3, 5, 2]);
    expect(hist.count).toBe(10);
    expect(hist.sum).toBe(42);
  });

  it('mirrors negative buckets and places the zero bucket in between', () => {
    const value = expHistogram({
      scale: 0,
      positive: { offset: 0, counts: [1] },
      negative: { offset: 0, counts: [1] },
      zeroCount: 4,
      zeroThreshold: 0.001,
      count: 6,
      sum: 0,
    });
    const hist = exponentialHistogramToHistogram(value);
    expect(hist.buckets).toHaveLength(3);
    expect(hist.buckets.map((b) => b.count)).toEqual([1, 4, 1]);
    expect(hist.buckets[0]!.upperLimit).toBeLessThan(hist.buckets[1]!.upperLimit);
    expect(hist.buckets[1]!.upperLimit).toBeLessThan(hist.buckets[2]!.upperLimit);
    expect(hist.buckets[1]!.upperLimit).toBe(0.001);
  });

  it('throws on a non-finite bucket boundary', () => {
    // scale -10 => base = 2 ** 1024, which already overflows a float64.
    const value = expHistogram({
      scale: -10,
      positive: { offset: 0, counts: [1] },
      count: 1,
      sum: 1,
    });
    expect(() => exponentialHistogramToHistogram(value)).toThrow(ValueTypeError);
  });
});

describe('samplesToHistogram', () => {
  it('places samples in inclusive upper-bound buckets, weighting by rate', () => {
    const h = samplesToHistogram(
      [
        { value: 0.5, rate: 1 },
        { value: 1, rate: 1 },
        { value: 3, rate: 2 },
        { value: 50, rate: 1 },
      ],
      [1, 5, 10],
    );
    expect(h.buckets.map((b) => b.count)).toEqual([2, 2, 0]);
    expect(h.count).toBe(5);
    expect(h.sum).toBe(57.5);
  });

  it('validates bounds', () => {
    expect(() => samplesToHistogram([], [1, 1])).toThrow(ValueTypeError);
    expect(() => samplesToHistogram([], [1, Infinity])).toThrow(ValueTypeError);
  });
});

describe('histogramQuantile', () => {
  it('interpolates within the target bucket', () => {
    const h = histogram([10, 10, 0], [1, 2, 3]);
    expect(histogramQuantile(h, 0.5)).toBe(1);
    expect(histogramQuantile(h, 0.25)).toBe(0.5);
    expect(histogramQuantile(h, 0.75)).toBe(1.5);
  });

  it('handles empty histograms, overflow, and invalid quantiles', () => {
    expect(histogramQuantile(histogram([]), 0.5)).toBeNaN();
    const overflow: Histogram = { ...histogram([1, 0, 0]), count: 10 };
    expect(histogramQuantile(overflow, 0.99)).toBe(10);
    expect(() => histogramQuantile(histogram([1]), 1.5)).toThrow(ValueTypeError);
  });
});

describe('samplesToSummary', () => {
  it('computes weighted nearest-rank quantiles', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({ value, rate: 1 }));
    const s = samplesToSummary(samples, [0, 0.5, 0.9, 1]);
    expect(s.quantiles.map((q) => q.value)).toEqual([1, 5, 9, 10]);
    expect(s.count).toBe(10);
    expect(s.sum).toBe(55);
    const weighted = samplesToSummary(
      [
        { value: 1, rate: 9 },
        { value: 100, rate: 1 },
      ],
      [0.5, 0.95],
    );
    expect(weighted.quantiles.map((q) => q.value)).toEqual([1, 100]);
  });

  it('returns NaN quantiles for no samples and rejects invalid quantiles', () => {
    expect(samplesToSummary([], [0.5]).quantiles[0]!.value).toBeNaN();
    expect(() => samplesToSummary([], [-0.1])).toThrow(ValueTypeError);
  });
});
