import fc from 'fast-check';
import {
  createMetadata,
  INT64_MAX,
  INT64_MIN,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  type Bucket,
  type Event,
  type EventMetadata,
  type ExponentialBuckets,
  type InstrumentationScope,
  type MetadataInit,
  type MetricValue,
  type Quantile,
  type Sample,
  type SpanAnnotation,
  type SpanInit,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  type Value,
  type ValueMap,
} from '@ferrule/core';

export const arbInteger: fc.Arbitrary<bigint> = fc.bigInt({ min: INT64_MIN, max: INT64_MAX });
export const arbFloat: fc.Arbitrary<number> = fc.double();
export const arbFiniteFloat: fc.Arbitrary<number> = fc.double({ noNaN: true });

export const arbTimestamp: fc.Arbitrary<Timestamp> = fc
  .bigInt({ min: -62_135_596_800_000_000_000n, max: 253_402_300_799_999_999_999n })
  .map((n) => Timestamp.fromNanos(n));

// Note: strings use fast-check's default (well-formed) unit rather than `'binary'`. The codec
// encodes strings as UTF-8, which — like every UTF-8-based wire format — cannot represent an
// unpaired UTF-16 surrogate; encoding one replaces it with U+FFFD (see codec.test.ts's dedicated
// test for that documented, non-crashing behavior). Well-formed Unicode text round-trips exactly.
export const arbScalar: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  arbInteger,
  arbFloat,
  fc.string(),
  fc.uint8Array({ maxLength: 16 }),
  arbTimestamp,
);

/** Arbitrary Ferrule values, nested up to a few levels deep. */
export const arbValue: fc.Arbitrary<Value> = fc.letrec<{ value: Value; map: ValueMap }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    arbScalar,
    fc.array(tie('value'), { maxLength: 4 }),
    tie('map'),
  ),
  map: fc
    .array(fc.tuple(fc.string(), tie('value')), { maxLength: 4 })
    .map((entries) => new Map(entries)),
})).value;

export const arbValueMap: fc.Arbitrary<ValueMap> = fc
  .array(fc.tuple(fc.string(), arbValue), { maxLength: 4 })
  .map((entries) => new Map(entries));

function arbOptional<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.option(arb, { nil: undefined });
}

interface ArbMetadataFields {
  sourceId: string | undefined;
  sourceType: string | undefined;
  receivedAt: Timestamp;
}

const arbMetadataFields: fc.Arbitrary<ArbMetadataFields> = fc.record({
  sourceId: arbOptional(fc.string({ minLength: 1, maxLength: 16 })),
  sourceType: arbOptional(fc.constantFrom('http', 'file', 'syslog', 'statsd')),
  receivedAt: arbTimestamp,
});

function buildMetadata(fields: ArbMetadataFields): EventMetadata {
  const init: MetadataInit = { receivedAt: fields.receivedAt };
  if (fields.sourceId !== undefined) init.sourceId = fields.sourceId;
  if (fields.sourceType !== undefined) init.sourceType = fields.sourceType;
  return createMetadata(init);
}

export const arbLogEvent: fc.Arbitrary<LogEvent> = fc
  .tuple(arbValueMap, arbMetadataFields)
  .map(([fields, metadata]) => new LogEvent(fields, buildMetadata(metadata)));

const arbSample: fc.Arbitrary<Sample> = fc.record({
  value: arbFiniteFloat,
  rate: fc.double({ min: 0, max: 10, noNaN: true }),
});
const arbBucket: fc.Arbitrary<Bucket> = fc.record({
  upperLimit: arbFiniteFloat,
  count: arbFiniteFloat,
});
const arbQuantile: fc.Arbitrary<Quantile> = fc.record({
  quantile: fc.double({ min: 0, max: 1, noNaN: true }),
  value: arbFiniteFloat,
});

const arbExponentialBuckets: fc.Arbitrary<ExponentialBuckets> = fc.record({
  offset: fc.integer({ min: -1000, max: 1000 }),
  counts: fc.array(arbFiniteFloat, { maxLength: 5 }),
});

export const arbMetricValue: fc.Arbitrary<MetricValue> = fc.oneof(
  fc.record({ type: fc.constant('counter' as const), value: arbFiniteFloat }),
  fc.record({ type: fc.constant('gauge' as const), value: arbFiniteFloat }),
  fc
    .array(fc.string(), { maxLength: 5 })
    .map((values) => ({ type: 'set' as const, values: new Set(values) })),
  fc.record({
    type: fc.constant('distribution' as const),
    statistic: fc.constantFrom('histogram' as const, 'summary' as const),
    samples: fc.array(arbSample, { maxLength: 5 }),
  }),
  fc.record({
    type: fc.constant('histogram' as const),
    buckets: fc.array(arbBucket, { maxLength: 5 }),
    count: arbFiniteFloat,
    sum: arbFiniteFloat,
  }),
  fc.record({
    type: fc.constant('exponentialHistogram' as const),
    scale: fc.integer({ min: -11, max: 20 }),
    zeroCount: arbFiniteFloat,
    zeroThreshold: arbFiniteFloat,
    positive: arbExponentialBuckets,
    negative: arbExponentialBuckets,
    count: arbFiniteFloat,
    sum: arbFiniteFloat,
  }),
  fc.record({
    type: fc.constant('summary' as const),
    quantiles: fc.array(arbQuantile, { maxLength: 5 }),
    count: arbFiniteFloat,
    sum: arbFiniteFloat,
  }),
);

export const arbMetricEvent: fc.Arbitrary<MetricEvent> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 24 }),
    namespace: arbOptional(fc.string({ minLength: 1, maxLength: 12 })),
    tags: fc.array(
      fc.tuple(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ maxLength: 8 })),
      {
        maxLength: 4,
      },
    ),
    kind: fc.constantFrom('incremental' as const, 'absolute' as const),
    value: arbMetricValue,
    timestamp: arbOptional(arbTimestamp),
    intervalMs: arbOptional(fc.double({ min: 0, max: 1e9, noNaN: true })),
    metadata: arbMetadataFields,
  })
  .map((fields) => {
    const init: ConstructorParameters<typeof MetricEvent>[0] = {
      name: fields.name,
      tags: new Map(fields.tags),
      kind: fields.kind,
      value: fields.value,
      metadata: buildMetadata(fields.metadata),
    };
    if (fields.namespace !== undefined) init.namespace = fields.namespace;
    if (fields.timestamp !== undefined) init.timestamp = fields.timestamp;
    if (fields.intervalMs !== undefined) init.intervalMs = fields.intervalMs;
    return new MetricEvent(init);
  });

const arbBytesN = (n: number): fc.Arbitrary<Uint8Array> =>
  fc.uint8Array({ minLength: n, maxLength: n });

const arbSpanKind: fc.Arbitrary<SpanKind> = fc.constantFrom(
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
);

const arbSpanStatus: fc.Arbitrary<SpanStatus> = fc
  .record({
    code: fc.constantFrom('unset' as const, 'ok' as const, 'error' as const),
    message: arbOptional(fc.string({ maxLength: 32 })),
  })
  .map(({ code, message }) => (message === undefined ? { code } : { code, message }));

const arbAnnotation: fc.Arbitrary<SpanAnnotation> = fc.record({
  name: fc.string({ maxLength: 16 }),
  time: arbTimestamp,
  attributes: arbValueMap,
});

const arbLink: fc.Arbitrary<SpanLink> = fc
  .record({
    traceId: fc.uint8Array({ minLength: 0, maxLength: 20 }),
    spanId: fc.uint8Array({ minLength: 0, maxLength: 12 }),
    traceState: arbOptional(fc.string({ maxLength: 16 })),
    attributes: arbValueMap,
  })
  .map(({ traceId, spanId, traceState, attributes }) => {
    const link: SpanLink = { traceId, spanId, attributes };
    if (traceState !== undefined) link.traceState = traceState;
    return link;
  });

export const arbSpanEvent: fc.Arbitrary<SpanEvent> = fc
  .record({
    traceId: arbBytesN(16),
    spanId: arbBytesN(8),
    parentSpanId: arbOptional(arbBytesN(8)),
    traceState: arbOptional(fc.string({ maxLength: 16 })),
    name: fc.string({ minLength: 1, maxLength: 24 }),
    spanKind: arbSpanKind,
    startNanos: fc.bigInt({ min: 0n, max: 4_102_444_800_000_000_000n }),
    durationNanos: fc.bigInt({ min: 0n, max: 3_600_000_000_000n }),
    status: arbSpanStatus,
    attributes: arbValueMap,
    annotations: fc.array(arbAnnotation, { maxLength: 3 }),
    links: fc.array(arbLink, { maxLength: 3 }),
    resource: arbValueMap,
    scopeName: arbOptional(fc.string({ minLength: 1, maxLength: 16 })),
    scopeVersion: arbOptional(fc.string({ maxLength: 8 })),
    scopeAttributes: arbValueMap,
    metadata: arbMetadataFields,
  })
  .map((f) => {
    const init: SpanInit = {
      traceId: f.traceId,
      spanId: f.spanId,
      name: f.name,
      spanKind: f.spanKind,
      startTime: Timestamp.fromNanos(f.startNanos),
      endTime: Timestamp.fromNanos(f.startNanos + f.durationNanos),
      status: f.status,
      attributes: f.attributes,
      annotations: f.annotations,
      links: f.links,
      resource: f.resource,
      metadata: buildMetadata(f.metadata),
    };
    if (f.parentSpanId !== undefined) init.parentSpanId = f.parentSpanId;
    if (f.traceState !== undefined) init.traceState = f.traceState;
    if (f.scopeName !== undefined) {
      const scope: InstrumentationScope = { name: f.scopeName, attributes: f.scopeAttributes };
      if (f.scopeVersion !== undefined) scope.version = f.scopeVersion;
      init.scope = scope;
    }
    return new SpanEvent(init);
  });

export const arbEvent: fc.Arbitrary<Event> = fc.oneof(arbLogEvent, arbMetricEvent, arbSpanEvent);
