import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MetricEvent, Timestamp, type MetricKind } from '@ferrule/core';
import {
  decodeExportMetricsServiceRequest,
  decodeOtlpJsonMetrics,
  encodeExportMetricsServiceRequest,
  encodeOtlpJsonMetrics,
} from '@ferrule/codecs';
import { arbExponentialHistogram, arbTagMap } from './arbitraries.js';

/**
 * The two round-trip properties for exponential histograms, for both OTLP encodings:
 *
 * 1. Any core value survives encode → decode unchanged.
 * 2. Bytes (or text) this encoder produced re-encode identically after a decode, i.e. encoding is
 *    a fixpoint. Externally produced messages need not be: core drops `min`, `max`, `flags`,
 *    exemplars, and whether the optional `sum` was present.
 */

const arbEvent: fc.Arbitrary<MetricEvent> = fc
  .record({
    // A small name pool, so several events share one OTLP `Metric`.
    name: fc.constantFrom('a', 'b'),
    tags: arbTagMap,
    kind: fc.constantFrom<MetricKind>('incremental', 'absolute'),
    value: arbExponentialHistogram,
    // Late enough that subtracting any interval leaves a positive start time.
    nanos: fc.bigInt({ min: 10n ** 15n, max: 4_102_444_800_000_000_000n }),
    intervalMs: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
  })
  .map(({ nanos, intervalMs, ...init }) => {
    const event = new MetricEvent({ ...init, timestamp: Timestamp.fromNanos(nanos) });
    if (intervalMs !== undefined) event.intervalMs = intervalMs;
    return event;
  });

function comparable(e: MetricEvent) {
  return {
    name: e.series.name,
    tags: e.series.tags,
    kind: e.metricKind,
    value: e.value,
    timestamp: e.timestamp?.nanos,
    intervalMs: e.intervalMs,
  };
}

/** Decoded order follows `Metric` grouping, so compare as multisets keyed by a stable string. */
function sortedComparable(events: readonly MetricEvent[]) {
  return events
    .map((e) => ({ key: JSON.stringify(comparable(e), replacer), e: comparable(e) }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .map((x) => x.e);
}

function replacer(_key: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Map) return [...v.entries()];
  return v;
}

const formats = [
  {
    name: 'protobuf',
    encode: encodeExportMetricsServiceRequest,
    decode: decodeExportMetricsServiceRequest,
  },
  { name: 'JSON', encode: encodeOtlpJsonMetrics, decode: decodeOtlpJsonMetrics },
] as const;

for (const format of formats) {
  describe(`OTLP ${format.name}: exponential histogram round trips`, () => {
    const encode = format.encode as (events: readonly MetricEvent[]) => Uint8Array | string;
    const decode = format.decode as (input: Uint8Array | string) => MetricEvent[];

    it('decode(encode(v)) reproduces every core value, kind, tag, and timestamp', () => {
      fc.assert(
        fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 6 }), (events) => {
          const decoded = decode(encode(events));
          expect(sortedComparable(decoded)).toEqual(sortedComparable(events));
        }),
        { numRuns: 300 },
      );
    });

    it('encode(decode(x)) === x for anything this encoder produced', () => {
      fc.assert(
        fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 6 }), (events) => {
          const encoded = encode(events);
          expect(encode(decode(encoded))).toEqual(encoded);
        }),
        { numRuns: 300 },
      );
    });

    it('keeps delta and cumulative series of one name apart', () => {
      const value = {
        type: 'exponential_histogram' as const,
        scale: 0,
        zeroCount: 0,
        zeroThreshold: 0,
        positive: { offset: 0, counts: [1] },
        negative: { offset: 0, counts: [] },
        count: 1,
        sum: 1.5,
      };
      const at = Timestamp.fromMillis(1000);
      const events = [
        new MetricEvent({ name: 'h', tags: new Map(), kind: 'incremental', value, timestamp: at }),
        new MetricEvent({ name: 'h', tags: new Map(), kind: 'absolute', value, timestamp: at }),
      ];
      const kinds = decode(encode(events)).map((e) => e.metricKind);
      expect(kinds.sort()).toEqual(['absolute', 'incremental']);
    });
  });
}
