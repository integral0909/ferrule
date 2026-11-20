import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMetricValues,
  canAdd,
  cloneMetricValue,
  exponentialToExplicitHistogram,
  MAX_EXPONENTIAL_BUCKETS,
  subtractMetricValues,
  ValueTypeError,
  zeroMetricValue,
  type ExponentialBuckets,
  type ExponentialHistogram,
} from '@ferrule/core';

const exp = (
  scale: number,
  positive: ExponentialBuckets,
  init: Partial<Omit<ExponentialHistogram, 'type' | 'scale' | 'positive'>> = {},
): ExponentialHistogram => {
  const negative = init.negative ?? { offset: 0, counts: [] };
  const zeroCount = init.zeroCount ?? 0;
  const total = (b: ExponentialBuckets): number => b.counts.reduce((x, y) => x + y, 0);
  return {
    type: 'exponential_histogram',
    scale,
    zeroCount,
    zeroThreshold: init.zeroThreshold ?? 0,
    positive,
    negative,
    count: init.count ?? total(positive) + total(negative) + zeroCount,
    sum: init.sum ?? 0,
  };
};

// ---------------------------------------------------------------------------------------------
// Reference implementation. It shares no code with core: instead of shifting indices, it maps
// each source bucket to the target bucket containing that bucket's upper boundary, working on
// the exact exponent of that boundary (bucket `i` at scale `s` ends at 2^((i+1) / 2^s)).
// ---------------------------------------------------------------------------------------------

/** Index at scale `target` of the bucket containing the upper boundary of `index` at `scale`. */
function boundaryRebin(index: number, scale: number, target: number): number {
  // Smallest j with (index + 1) / 2^scale <= (j + 1) / 2^target. Division by a power of two
  // is exact for these magnitudes, so Math.ceil sees the exact rational.
  return Math.ceil((index + 1) / 2 ** (scale - target)) - 1;
}

interface Slot {
  index: number;
  count: number;
}

function slots(b: ExponentialBuckets): Slot[] {
  return b.counts.map((count, k) => ({ index: b.offset + k, count }));
}

function oracleCombine(
  a: ExponentialHistogram,
  b: ExponentialHistogram,
  sign: 1 | -1,
): ExponentialHistogram {
  const threshold = Math.max(a.zeroThreshold, b.zeroThreshold);
  const fold = (h: ExponentialHistogram) => {
    let zero = h.zeroCount;
    const keep = (range: ExponentialBuckets): Slot[] =>
      slots(range).filter((s) => {
        const upper = Math.pow(2, (s.index + 1) * Math.pow(2, -h.scale));
        if (upper <= threshold) {
          zero += s.count;
          return false;
        }
        return true;
      });
    const positive = keep(h.positive);
    const negative = keep(h.negative);
    return { scale: h.scale, zero, positive, negative };
  };
  const fa = fold(a);
  const fb = fold(b);

  const span = (target: number, which: 'positive' | 'negative'): number => {
    const all = [
      ...fa[which].map((s) => boundaryRebin(s.index, fa.scale, target)),
      ...fb[which].map((s) => boundaryRebin(s.index, fb.scale, target)),
    ];
    return all.length === 0 ? 0 : Math.max(...all) - Math.min(...all) + 1;
  };
  let target = Math.min(a.scale, b.scale);
  while (
    span(target, 'positive') > MAX_EXPONENTIAL_BUCKETS ||
    span(target, 'negative') > MAX_EXPONENTIAL_BUCKETS
  ) {
    target--;
  }

  const build = (which: 'positive' | 'negative'): ExponentialBuckets => {
    const rebinned = new Map<number, number>();
    const put = (index: number, count: number): void => {
      rebinned.set(index, (rebinned.get(index) ?? 0) + count);
    };
    for (const s of fa[which]) put(boundaryRebin(s.index, fa.scale, target), s.count);
    for (const s of fb[which]) put(boundaryRebin(s.index, fb.scale, target), sign * s.count);
    if (rebinned.size === 0) return { offset: 0, counts: [] };
    const lo = Math.min(...rebinned.keys());
    const hi = Math.max(...rebinned.keys());
    const counts: number[] = [];
    for (let i = lo; i <= hi; i++) counts.push(rebinned.get(i) ?? 0);
    return { offset: lo, counts };
  };

  return {
    type: 'exponential_histogram',
    scale: target,
    zeroCount: fa.zero + sign * fb.zero,
    zeroThreshold: threshold,
    positive: build('positive'),
    negative: build('negative'),
    count: a.count + sign * b.count,
    sum: a.sum + sign * b.sum,
  };
}

// ---------------------------------------------------------------------------------------------

const bucketsArb = (maxOffset: number): fc.Arbitrary<ExponentialBuckets> =>
  fc.record({
    offset: fc.integer({ min: -maxOffset, max: maxOffset }),
    counts: fc.array(fc.nat({ max: 1000 }), { maxLength: 24 }),
  });

/** Offsets wide enough that merges regularly exceed the bucket cap and must downscale further. */
const expArb = (maxOffset = 400): fc.Arbitrary<ExponentialHistogram> =>
  fc
    .record({
      scale: fc.integer({ min: -3, max: 8 }),
      positive: bucketsArb(maxOffset),
      negative: bucketsArb(maxOffset),
      zeroCount: fc.nat({ max: 1000 }),
      zeroThreshold: fc.constantFrom(0, 0, 0, 0.5, 1, 1.5, 4),
      sum: fc.integer({ min: -1e6, max: 1e6 }),
    })
    .map(({ scale, positive, ...rest }) => exp(scale, positive, rest));

describe('exponential histograms: merge', () => {
  it('any two exponential histograms can be added, but not with explicit ones', () => {
    const a = exp(3, { offset: 0, counts: [1] });
    const b = exp(-2, { offset: 5, counts: [2] });
    expect(canAdd(a, b)).toBe(true);
    const explicit = { type: 'histogram' as const, buckets: [], count: 0, sum: 0 };
    expect(canAdd(a, explicit)).toBe(false);
    expect(addMetricValues(a, explicit)).toBeUndefined();
  });

  it('adds bucket-wise at equal scales, extending the range to cover both', () => {
    const a = exp(1, { offset: 2, counts: [1, 2] }, { zeroCount: 1, sum: 10 });
    const b = exp(1, { offset: 3, counts: [5, 7] }, { zeroCount: 2, sum: 5 });
    expect(addMetricValues(a, b)).toEqual(
      exp(1, { offset: 2, counts: [1, 7, 7] }, { zeroCount: 3, sum: 15 }),
    );
  });

  it('downscales the finer histogram, merging adjacent bucket pairs per scale step', () => {
    // Scale 1 → 0 maps index i to floor(i / 2): -3→-2, -2→-1, -1→-1, 0→0, 1→0, 2→1.
    const fine = exp(1, { offset: -3, counts: [1, 2, 3, 4, 5, 6] });
    const coarse = exp(0, { offset: 0, counts: [100] });
    const merged = addMetricValues(fine, coarse) as ExponentialHistogram;
    expect(merged.scale).toBe(0);
    expect(merged.positive).toEqual({ offset: -2, counts: [1, 5, 109, 6] });
  });

  it('downscales further when the merged range would exceed the bucket cap', () => {
    const low = exp(0, { offset: 0, counts: [1] });
    const high = exp(0, { offset: MAX_EXPONENTIAL_BUCKETS, counts: [1] }); // span cap + 1
    const merged = addMetricValues(low, high) as ExponentialHistogram;
    expect(merged.scale).toBe(-1);
    expect(merged.positive.counts.length).toBeLessThanOrEqual(MAX_EXPONENTIAL_BUCKETS);
    expect(merged.positive).toEqual({
      offset: 0,
      counts: [1, ...new Array<number>(MAX_EXPONENTIAL_BUCKETS / 2 - 1).fill(0), 1],
    });
  });

  it('folds buckets inside the larger zero threshold into the zero count', () => {
    // Scale 0: bucket i covers (2^i, 2^(i+1)]; with threshold 2, buckets -1 (≤1) and 0 (≤2) fold.
    const a = exp(0, { offset: -1, counts: [3, 4, 5] }, { zeroCount: 1 });
    const b = exp(0, { offset: 1, counts: [1] }, { zeroCount: 2, zeroThreshold: 2 });
    expect(addMetricValues(a, b)).toEqual(
      exp(0, { offset: 1, counts: [6] }, { zeroCount: 10, zeroThreshold: 2, count: 16 }),
    );
  });

  it('matches the boundary-based reference implementation', () => {
    fc.assert(
      fc.property(expArb(), expArb(), (a, b) => {
        expect(addMetricValues(a, b)).toEqual(oracleCombine(a, b, 1));
      }),
      { numRuns: 500 },
    );
  });

  it('never exceeds the bucket cap and preserves the total count', () => {
    fc.assert(
      fc.property(expArb(5000), expArb(5000), (a, b) => {
        const m = addMetricValues(a, b) as ExponentialHistogram;
        expect(m.positive.counts.length).toBeLessThanOrEqual(MAX_EXPONENTIAL_BUCKETS);
        expect(m.negative.counts.length).toBeLessThanOrEqual(MAX_EXPONENTIAL_BUCKETS);
        const total = (h: ExponentialHistogram): number =>
          h.zeroCount +
          h.positive.counts.reduce((x, y) => x + y, 0) +
          h.negative.counts.reduce((x, y) => x + y, 0);
        expect(total(m)).toBe(total(a) + total(b));
      }),
    );
  });

  it('is commutative and does not mutate its inputs', () => {
    fc.assert(
      fc.property(expArb(), expArb(), (a, b) => {
        const [ca, cb] = [cloneMetricValue(a), cloneMetricValue(b)];
        expect(addMetricValues(a, b)).toEqual(addMetricValues(b, a));
        expect(a).toEqual(ca);
        expect(b).toEqual(cb);
      }),
    );
  });
});

describe('exponential histograms: subtract', () => {
  it('matches the reference implementation, reporting a reset when anything decreased', () => {
    fc.assert(
      fc.property(expArb(), expArb(), (current, previous) => {
        const expected = oracleCombine(current, previous, -1);
        const negative =
          expected.count < 0 ||
          expected.zeroCount < 0 ||
          [...expected.positive.counts, ...expected.negative.counts].some((c) => c < 0);
        expect(subtractMetricValues(current, previous)).toEqual(
          negative ? { kind: 'reset', value: current } : { kind: 'delta', value: expected },
        );
      }),
      { numRuns: 500 },
    );
  });

  it('recovers the increment of a cumulative series that downscaled between readings', () => {
    fc.assert(
      fc.property(expArb(), expArb(), (previous, increment) => {
        const current = addMetricValues(previous, increment) as ExponentialHistogram;
        const result = subtractMetricValues(current, previous);
        expect(result.kind).toBe('delta');
        const delta = (result as { value: ExponentialHistogram }).value;
        expect(delta.scale).toBe(current.scale);
        expect(delta.count).toBe(increment.count);
        // Re-adding the delta to the previous reading reproduces the current one.
        expect(addMetricValues(previous, delta)).toEqual(current);
      }),
    );
  });

  it('subtracts bucket-wise across different scales', () => {
    const previous = exp(2, { offset: 0, counts: [1, 1, 1, 1] }); // → scale 1: [2, 2]
    const current = exp(1, { offset: 0, counts: [3, 5] });
    expect(subtractMetricValues(current, previous)).toEqual({
      kind: 'delta',
      value: exp(1, { offset: 0, counts: [1, 3] }),
    });
  });
});

describe('exponential histograms: zero, clone', () => {
  it('zeroMetricValue keeps the layout with every count cleared', () => {
    const h = exp(
      2,
      { offset: -1, counts: [1, 2] },
      { negative: { offset: 3, counts: [4] }, zeroCount: 5, zeroThreshold: 0.5, sum: 9 },
    );
    expect(zeroMetricValue(h)).toEqual(
      exp(
        2,
        { offset: -1, counts: [0, 0] },
        { negative: { offset: 3, counts: [0] }, zeroThreshold: 0.5 },
      ),
    );
  });

  it('cloneMetricValue copies the bucket arrays', () => {
    const h = exp(0, { offset: 0, counts: [1] });
    const c = cloneMetricValue(h) as ExponentialHistogram;
    c.positive.counts[0] = 99;
    expect(h.positive.counts[0]).toBe(1);
  });
});

describe('exponentialToExplicitHistogram', () => {
  it('maps negative, zero, and positive ranges to ascending explicit buckets', () => {
    const h = exp(
      0,
      { offset: 1, counts: [3, 4] },
      { negative: { offset: 0, counts: [1, 2] }, zeroCount: 5, zeroThreshold: 0.25, sum: 7 },
    );
    expect(exponentialToExplicitHistogram(h)).toEqual({
      type: 'histogram',
      buckets: [
        { upperLimit: -2, count: 2 },
        { upperLimit: -1, count: 1 },
        { upperLimit: 0.25, count: 5 },
        { upperLimit: 4, count: 3 },
        { upperLimit: 8, count: 4 },
      ],
      count: 15,
      sum: 7,
    });
  });

  it('produces strictly increasing bounds carrying every observation', () => {
    fc.assert(
      fc.property(expArb(40), (h) => {
        const explicit = exponentialToExplicitHistogram({ ...h, zeroThreshold: 0 });
        for (let i = 1; i < explicit.buckets.length; i++) {
          expect(explicit.buckets[i]!.upperLimit).toBeGreaterThan(
            explicit.buckets[i - 1]!.upperLimit,
          );
        }
        expect(explicit.buckets.reduce((s, b) => s + b.count, 0)).toBe(h.count);
      }),
    );
  });

  it('computes boundaries exactly where scales share them, so they agree across scales', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: -60, max: 60 }),
        (scale, e) => {
          // Bucket e·2^scale − 1 ends at exactly 2^e at every scale ≥ 0.
          const index = e * 2 ** scale - 1;
          const [bucket] = exponentialToExplicitHistogram(
            exp(scale, { offset: index, counts: [1] }),
          ).buckets;
          expect(bucket!.upperLimit).toBe(2 ** e);
        },
      ),
    );
    // The double-rounding case that motivated this: base^2 at scale 1 is 2.0000000000000004.
    expect(
      exponentialToExplicitHistogram(exp(1, { offset: 1, counts: [1] })).buckets[0]!.upperLimit,
    ).toBe(2);
  });

  it('rejects boundaries that overflow to infinity', () => {
    expect(() => exponentialToExplicitHistogram(exp(-10, { offset: 5, counts: [1] }))).toThrow(
      ValueTypeError,
    );
  });
});
