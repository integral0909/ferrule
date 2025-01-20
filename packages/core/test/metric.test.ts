import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMetricValues,
  canAdd,
  cloneMetricValue,
  histogramQuantile,
  samplesToHistogram,
  samplesToSummary,
  seriesKey,
  subtractMetricValues,
  ValueTypeError,
  zeroMetricValue,
  type MetricSeries,
  type MetricValue,
} from '@ferrule/core';

type Histogram = Extract<MetricValue, { type: 'histogram' }>;

const histogram = (counts: number[], bounds = [1, 5, 10], sum = 0): Histogram => ({
  type: 'histogram',
  buckets: bounds.map((upperLimit, i) => ({ upperLimit, count: counts[i] ?? 0 })),
  count: counts.reduce((a, b) => a + b, 0),
  sum,
});

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
