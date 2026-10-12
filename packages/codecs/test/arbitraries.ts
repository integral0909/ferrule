import fc from 'fast-check';
import {
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  type Bucket,
  type ExponentialBuckets,
  type MetricValue,
  type Quantile,
  type Sample,
  type SpanAnnotation,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  type Value,
  type ValueMap,
} from '@ferrule/core';

/** Splits `bytes` into a random sequence of chunks whose concatenation is `bytes`, for exercising
 * "chunk-splitting invariance": feeding the same data through a `Framer` split any way must
 * produce the same frames. */
export function arbChunked(bytes: Uint8Array): fc.Arbitrary<Uint8Array[]> {
  if (bytes.length === 0) return fc.constant([]);
  return fc
    .array(fc.integer({ min: 0, max: bytes.length }), { minLength: 0, maxLength: 12 })
    .map((cutsRaw) => {
      const cuts = [...new Set([0, bytes.length, ...cutsRaw])].sort((a, b) => a - b);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < cuts.length - 1; i++) chunks.push(bytes.slice(cuts[i], cuts[i + 1]));
      return chunks.filter((c) => c.length > 0 || chunks.length === 1);
    });
}

export const arbBytesN = (n: number): fc.Arbitrary<Uint8Array> =>
  fc.uint8Array({ minLength: n, maxLength: n });

export const arbTraceId: fc.Arbitrary<Uint8Array> = arbBytesN(16).filter((b) =>
  b.some((x) => x !== 0),
);
export const arbSpanId: fc.Arbitrary<Uint8Array> = arbBytesN(8).filter((b) =>
  b.some((x) => x !== 0),
);

// OTLP's fixed64 timestamp fields use 0 to mean "unset" (per the spec), so an arbitrary spanning
// exactly the epoch is ambiguous for round-trip tests; start just after it.
export const arbTimestamp: fc.Arbitrary<Timestamp> = fc
  .bigInt({ min: 1n, max: 4_102_444_800_000_000_000n })
  .map((n) => Timestamp.fromNanos(n));

/** A "safe" identifier-ish string: printable ASCII, no control characters, non-empty. */
export const arbSafeString: fc.Arbitrary<string> = fc
  .string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 24 })
  .filter((s) => !/[\p{Cc}]/u.test(s));

export const arbTagMap: fc.Arbitrary<Map<string, string>> = fc
  .array(fc.tuple(arbSafeString, arbSafeString), { maxLength: 5 })
  .map((entries) => new Map(entries));

export const arbAttrValue: fc.Arbitrary<Value> = fc.oneof(
  arbSafeString,
  fc.boolean(),
  fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

export const arbAttributes: fc.Arbitrary<ValueMap> = fc
  .array(fc.tuple(arbSafeString, arbAttrValue), { maxLength: 5 })
  .map((entries) => new Map(entries));

export const arbLogEvent: fc.Arbitrary<LogEvent> = fc
  .record({
    message: arbSafeString,
    // 0 means "unspecified" and is dropped by the OTLP mapping's documented convention, so avoid
    // it here to keep this a round-trip-exact arbitrary.
    severity: fc.integer({ min: 1, max: 24 }),
  })
  .map(({ message, severity }) => {
    const event = LogEvent.fromMessage(message);
    event.set('severity_number', BigInt(severity));
    return event;
  });

const arbBucket: fc.Arbitrary<Bucket> = fc
  .tuple(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.nat(1000))
  .map(([upperLimit, count]) => ({ upperLimit, count }));

const arbSortedBuckets: fc.Arbitrary<Bucket[]> = fc
  .array(arbBucket, { maxLength: 6 })
  .map((buckets) => {
    const sorted = [...buckets].sort((a, b) => a.upperLimit - b.upperLimit);
    const seen = new Set<number>();
    return sorted.filter((b) => {
      if (seen.has(b.upperLimit)) return false;
      seen.add(b.upperLimit);
      return true;
    });
  });

const arbQuantile: fc.Arbitrary<Quantile> = fc
  .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }))
  .map(([quantile, value]) => ({ quantile, value }));

const arbSample: fc.Arbitrary<Sample> = fc
  .tuple(
    fc.double({ min: -1e6, max: 1e6, noNaN: true }),
    fc.double({ min: 0.001, max: 100, noNaN: true }),
  )
  .map(([value, rate]) => ({ value, rate }));

/** Non-negative integer-valued counts, bounded to a range that round-trips exactly through both
 * a `fixed64`/varint wire encoding and a float64 in-memory representation. */
const arbBucketCount = (max = 1000): fc.Arbitrary<number> => fc.nat(max);

export const arbExponentialBuckets: fc.Arbitrary<ExponentialBuckets> = fc.record({
  offset: fc.integer({ min: -1000, max: 1000 }),
  counts: fc.array(arbBucketCount(), { maxLength: 5 }),
});

export const arbExponentialHistogram: fc.Arbitrary<
  Extract<MetricValue, { type: 'exponentialHistogram' }>
> = fc
  .record({
    scale: fc.integer({ min: -10, max: 20 }),
    zeroCount: arbBucketCount(),
    zeroThreshold: fc.double({ min: 0, max: 10, noNaN: true }),
    positive: arbExponentialBuckets,
    negative: arbExponentialBuckets,
    count: arbBucketCount(10_000),
    sum: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  })
  .map((fields) => ({ type: 'exponentialHistogram' as const, ...fields }));

export const arbMetricValue: fc.Arbitrary<MetricValue> = fc.oneof(
  fc
    .double({ noNaN: true, min: -1e9, max: 1e9 })
    .map((value): MetricValue => ({ type: 'counter', value })),
  fc
    .double({ noNaN: true, min: -1e9, max: 1e9 })
    .map((value): MetricValue => ({ type: 'gauge', value })),
  fc
    .array(arbSafeString, { maxLength: 5 })
    .map((values): MetricValue => ({ type: 'set', values: new Set(values) })),
  fc
    .array(arbSample, { maxLength: 5 })
    .map((samples): MetricValue => ({ type: 'distribution', statistic: 'histogram', samples })),
  arbSortedBuckets.chain((buckets) =>
    fc
      .tuple(fc.nat(10_000), fc.double({ min: 0, max: 1e6, noNaN: true }))
      .map(([count, sum]): MetricValue => ({ type: 'histogram', buckets, count, sum })),
  ),
  arbExponentialHistogram,
  fc
    .array(arbQuantile, { maxLength: 5 })
    .chain((quantiles) =>
      fc
        .tuple(fc.nat(10_000), fc.double({ min: 0, max: 1e6, noNaN: true }))
        .map(([count, sum]): MetricValue => ({ type: 'summary', quantiles, count, sum })),
    ),
);

export const arbMetricEvent: fc.Arbitrary<MetricEvent> = fc
  .record({
    name: arbSafeString,
    tags: arbTagMap,
    value: arbMetricValue,
    timestamp: arbTimestamp,
  })
  .map(
    ({ name, tags, value, timestamp }) =>
      new MetricEvent({
        name,
        tags,
        kind: 'absolute',
        value,
        timestamp,
      }),
  );

const arbSpanKind: fc.Arbitrary<SpanKind> = fc.constantFrom(
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
);

const arbSpanStatus: fc.Arbitrary<SpanStatus> = fc.oneof(
  fc.constant<SpanStatus>({ code: 'unset' }),
  fc.constant<SpanStatus>({ code: 'ok' }),
  arbSafeString.map((message): SpanStatus => ({ code: 'error', message })),
);

const arbAnnotation: fc.Arbitrary<SpanAnnotation> = fc
  .record({ name: arbSafeString, time: arbTimestamp, attributes: arbAttributes })
  .map(({ name, time, attributes }) => ({ name, time, attributes }));

const arbLink: fc.Arbitrary<SpanLink> = fc
  .record({ traceId: arbTraceId, spanId: arbSpanId, attributes: arbAttributes })
  .map(({ traceId, spanId, attributes }) => ({ traceId, spanId, attributes }));

export const arbSpanEvent: fc.Arbitrary<SpanEvent> = fc
  .record({
    traceId: arbTraceId,
    spanId: arbSpanId,
    name: arbSafeString,
    spanKind: arbSpanKind,
    startTime: arbTimestamp,
    durationNanos: fc.bigInt({ min: 0n, max: 1_000_000_000n }),
    status: arbSpanStatus,
    attributes: arbAttributes,
    annotations: fc.array(arbAnnotation, { maxLength: 3 }),
    links: fc.array(arbLink, { maxLength: 3 }),
    resource: arbAttributes,
  })
  .map(
    ({
      traceId,
      spanId,
      name,
      spanKind,
      startTime,
      durationNanos,
      status,
      attributes,
      annotations,
      links,
      resource,
    }) =>
      new SpanEvent({
        traceId,
        spanId,
        name,
        spanKind,
        startTime,
        endTime: startTime.add(durationNanos),
        status,
        attributes,
        annotations,
        links,
        resource,
      }),
  );
