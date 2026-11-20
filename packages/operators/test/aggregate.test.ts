import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MetricEvent, MetricKind } from '@ferrule/core';
import { aggregateTransform } from '@ferrule/operators';
import { buildTransform, counterMetric, gaugeMetric, metricEvent, sealedBatch } from './helpers.js';

describe('aggregate', () => {
  it('sums incremental counters for the same series within a window', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, { interval: 1000 });
    const events = [counterMetric('reqs', 1), counterMetric('reqs', 2), counterMetric('reqs', 3)];
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0); // nothing flushes until tick

    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.value).toEqual({ type: 'counter', value: 6 });
    expect(out.metricKind).toBe('incremental');
  });

  it('keeps the latest absolute (gauge) reading within a window', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, { interval: 1000 });
    transform.process([gaugeMetric('mem', 10), gaugeMetric('mem', 20)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.value).toEqual({ type: 'gauge', value: 20 });
    expect(out.metricKind).toBe('absolute');
  });

  it('does not emit a series with no updates since the last flush', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, { interval: 1000 });
    transform.process([counterMetric('reqs', 1)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
    transform.tick!(harness.clock.now(), harness.out); // no new events since the last flush
    expect(harness.pushed).toHaveLength(1);
  });

  it('convert_absolute_to_incremental turns consecutive absolute readings into deltas', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, {
      interval: 1000,
      convert_absolute_to_incremental: true,
    });
    transform.process([absoluteCounter('bytes_total', 100)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(0); // first reading only primes the delta

    transform.process([absoluteCounter('bytes_total', 150)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.value).toEqual({ type: 'counter', value: 50 });
  });

  it('convert_absolute_to_incremental treats a decreasing counter as a reset', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, {
      interval: 1000,
      convert_absolute_to_incremental: true,
    });
    transform.process([absoluteCounter('c', 100)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);
    transform.process([absoluteCounter('c', 10)], harness.out); // source restarted
    transform.tick!(harness.clock.now(), harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.value).toEqual({ type: 'counter', value: 10 }); // the reset reading itself, as-is
  });

  it('convert_incremental_to_absolute emits a running total across windows', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, {
      interval: 1000,
      convert_incremental_to_absolute: true,
    });
    transform.process([counterMetric('reqs', 5)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);
    transform.process([counterMetric('reqs', 3)], harness.out);
    transform.tick!(harness.clock.now(), harness.out);

    const values = harness.pushed.map((p) => (p.event as MetricEvent).value);
    expect(values).toEqual([
      { type: 'counter', value: 5 },
      { type: 'counter', value: 8 },
    ]);
    expect(harness.pushed.every((p) => (p.event as MetricEvent).metricKind === 'absolute')).toBe(
      true,
    );
  });

  it('merges incremental exponential histograms at different scales within a window', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, { interval: 1000 });
    transform.process(
      [
        // Scale 2 indices 0..3 all fall in scale-0 bucket 0, i.e. (1, 2].
        exponentialMetric('incremental', 2, { offset: 0, counts: [1, 1, 1, 1] }, 5),
        exponentialMetric('incremental', 0, { offset: 0, counts: [2, 3] }, 7),
        exponentialMetric('incremental', 1, { offset: 2, counts: [4] }, 9),
      ],
      harness.out,
    );
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.metricKind).toBe('incremental');
    expect(out.value).toEqual({
      type: 'exponential_histogram',
      scale: 0,
      zeroCount: 0,
      zeroThreshold: 0,
      // Bucket 0: 4 (from scale 2) + 2; bucket 1: 3 + 4 (scale-1 index 2 → floor(2 / 2) = 1).
      positive: { offset: 0, counts: [6, 7] },
      negative: { offset: 0, counts: [] },
      count: 13,
      sum: 21,
    });
  });

  it('convert_absolute_to_incremental deltas a cumulative exponential series that downscaled', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, {
      interval: 1000,
      convert_absolute_to_incremental: true,
    });
    transform.process(
      [exponentialMetric('absolute', 1, { offset: 0, counts: [1, 2] }, 3)],
      harness.out,
    );
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(0); // first reading only primes the delta

    // The SDK widened its range and lowered the scale: (1, 2] now holds 3 + 2 new observations.
    transform.process(
      [exponentialMetric('absolute', 0, { offset: 0, counts: [5, 1] }, 11)],
      harness.out,
    );
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect((harness.pushed[0]!.event as MetricEvent).value).toEqual({
      type: 'exponential_histogram',
      scale: 0,
      zeroCount: 0,
      zeroThreshold: 0,
      positive: { offset: 0, counts: [2, 1] },
      negative: { offset: 0, counts: [] },
      count: 3,
      sum: 8,
    });
  });

  it('the flushed aggregate carries the merged finalizers of every contributing event', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, { interval: 1000 });
    const events = [counterMetric('reqs', 1), counterMetric('reqs', 1), counterMetric('reqs', 1)];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(batch.pendingCount).toBe(3); // still held by the aggregate, not yet delivered

    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.metadata.finalizers.isEmpty).toBe(false);
    out.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('evicts and force-finishes (errored) series beyond max_series', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, {
      interval: 1000,
      max_series: 1,
    });
    const a = counterMetric('a', 1);
    const b = counterMetric('b', 1);
    const batchA = sealedBatch([a]);
    transform.process([a], harness.out);
    transform.process([b], harness.out); // evicts series 'a' from the 1-entry LRU
    await expect(batchA.completion).resolves.toBe('errored');
  });

  it('flush() emits every remaining dirty series at shutdown', async () => {
    const { transform, harness } = await buildTransform(aggregateTransform, { interval: 60_000 });
    transform.process([counterMetric('reqs', 7)], harness.out);
    transform.flush!(harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect((harness.pushed[0]!.event as MetricEvent).value).toEqual({ type: 'counter', value: 7 });
  });

  it('property: aggregate conserves the total across any partition of a counter into windows', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 1, maxLength: 40 }),
        async (increments, flushPattern) => {
          const { transform, harness } = await buildTransform(aggregateTransform, {
            interval: 1000,
          });
          let total = 0;
          for (let i = 0; i < increments.length; i++) {
            transform.process([counterMetric('reqs', increments[i]!)], harness.out);
            total += increments[i]!;
            if (flushPattern[i % flushPattern.length] === 1) {
              transform.tick!(harness.clock.now(), harness.out);
            }
          }
          transform.flush!(harness.out);
          const observed = harness.pushed.reduce(
            (sum, p) =>
              sum + ((p.event as MetricEvent).value as { type: 'counter'; value: number }).value,
            0,
          );
          expect(observed).toBe(total);
        },
      ),
      { numRuns: 30 },
    );
  });
});

/** A `counter`-typed value reported as an absolute reading (e.g. a Prometheus scrape). */
function absoluteCounter(name: string, value: number): MetricEvent {
  const m = counterMetric(name, value);
  m.metricKind = 'absolute';
  return m;
}

function exponentialMetric(
  kind: MetricKind,
  scale: number,
  positive: { offset: number; counts: number[] },
  sum: number,
): MetricEvent {
  return metricEvent({
    name: 'latency',
    kind,
    value: {
      type: 'exponential_histogram',
      scale,
      zeroCount: 0,
      zeroThreshold: 0,
      positive,
      negative: { offset: 0, counts: [] },
      count: positive.counts.reduce((a, b) => a + b, 0),
      sum,
    },
  });
}
