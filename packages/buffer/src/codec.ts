import {
  createMetadata,
  FerruleError,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  type Bucket,
  type Event,
  type EventMetadata,
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
import { ByteReader, ByteWriter } from './byte-io.js';
import { CodecLimitExceededError, CodecMalformedError, CodecVersionError } from './errors.js';

/**
 * Binary event codec. See `FORMAT.md` for the full wire format. This module has two entry
 * points for each direction:
 *
 * - {@link encodeEvent} / {@link decodeEvent} — one event.
 * - {@link encodeEventBatch} / {@link decodeEventBatch} — many events sharing one envelope,
 *   used to pass events across a `worker_threads` boundary.
 *
 * Decoding is bounded: nesting depth, string/byte lengths, and collection sizes are all capped
 * (see {@link DecodeLimits}), and every failure — truncation, a bad tag, a limit violation, an
 * unsupported version — surfaces as a `FerruleError` subclass. Decoders never let an
 * unrelated JavaScript error (a bare `RangeError`, a `DOMException` from UTF-8 decoding, ...)
 * escape to the caller.
 */

export const FORMAT_VERSION = 1;

// --- Value tags ------------------------------------------------------------------------------

const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_INTEGER = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_BYTES = 6;
const TAG_TIMESTAMP = 7;
const TAG_ARRAY = 8;
const TAG_OBJECT = 9;

// --- Event kind bytes --------------------------------------------------------------------------

const KIND_LOG = 0;
const KIND_METRIC = 1;
const KIND_SPAN = 2;

// --- Metric value tags -------------------------------------------------------------------------

const METRIC_COUNTER = 0;
const METRIC_GAUGE = 1;
const METRIC_SET = 2;
const METRIC_DISTRIBUTION = 3;
const METRIC_HISTOGRAM = 4;
const METRIC_SUMMARY = 5;

const SPAN_KINDS: readonly SpanKind[] = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];
const SPAN_KIND_BYTES: Readonly<Record<SpanKind, number>> = {
  unspecified: 0,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const STATUS_CODES: readonly SpanStatus['code'][] = ['unset', 'ok', 'error'];
const STATUS_CODE_BYTES: Readonly<Record<SpanStatus['code'], number>> = {
  unset: 0,
  ok: 1,
  error: 2,
};

/** Limits enforced while decoding untrusted binary input. See `FORMAT.md` for defaults and rationale. */
export interface DecodeLimits {
  /** Maximum nesting depth of arrays/objects (and the attribute maps nested inside spans). */
  maxDepth?: number;
  /** Maximum length in bytes of any single string field (before UTF-8 decoding). */
  maxStringBytes?: number;
  /** Maximum length in bytes of any single `bytes` field. */
  maxBytesLength?: number;
  /** Maximum element count of any array, object, set, or repeated field. */
  maxCollectionLength?: number;
}

type ResolvedLimits = Required<DecodeLimits>;

const DEFAULT_LIMITS: ResolvedLimits = {
  maxDepth: 64,
  maxStringBytes: 16 * 1024 * 1024,
  maxBytesLength: 16 * 1024 * 1024,
  maxCollectionLength: 1_000_000,
};

function resolveLimits(limits: DecodeLimits): ResolvedLimits {
  return { ...DEFAULT_LIMITS, ...limits };
}

/** Encodes one event. The result is self-contained and versioned. */
export function encodeEvent(event: Event): Uint8Array {
  const w = new ByteWriter();
  w.writeUint8(FORMAT_VERSION);
  encodeEventBody(w, event);
  return w.toUint8Array();
}

/**
 * Decodes one event previously produced by {@link encodeEvent}. `limits` bounds the resources
 * the decode may consume; defaults are conservative enough for untrusted input.
 */
export function decodeEvent(bytes: Uint8Array, limits: DecodeLimits = {}): Event {
  return wrapDecodeErrors(() => {
    const resolved = resolveLimits(limits);
    const r = new ByteReader(bytes, { maxLength: resolved.maxCollectionLength });
    const version = r.readUint8();
    if (version !== FORMAT_VERSION) throw new CodecVersionError(version);
    const event = decodeEventBody(r, resolved);
    if (!r.atEnd()) throw new CodecMalformedError('trailing bytes after event');
    return event;
  });
}

/** Encodes several events sharing one envelope: used to cross a `worker_threads` boundary. */
export function encodeEventBatch(events: readonly Event[]): Uint8Array {
  const w = new ByteWriter();
  w.writeUint8(FORMAT_VERSION);
  w.writeVarint(events.length);
  for (const event of events) encodeEventBody(w, event);
  return w.toUint8Array();
}

/** Decodes a batch previously produced by {@link encodeEventBatch}. */
export function decodeEventBatch(bytes: Uint8Array, limits: DecodeLimits = {}): Event[] {
  return wrapDecodeErrors(() => {
    const resolved = resolveLimits(limits);
    const r = new ByteReader(bytes, { maxLength: resolved.maxCollectionLength });
    const version = r.readUint8();
    if (version !== FORMAT_VERSION) throw new CodecVersionError(version);
    const count = readCount(r, resolved.maxCollectionLength, 'batch.length');
    const events: Event[] = [];
    for (let i = 0; i < count; i++) events.push(decodeEventBody(r, resolved));
    if (!r.atEnd()) throw new CodecMalformedError('trailing bytes after event batch');
    return events;
  });
}

function wrapDecodeErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FerruleError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CodecMalformedError(`corrupt event encoding: ${message}`);
  }
}

function kindByte(event: Event): number {
  switch (event.kind) {
    case 'log':
      return KIND_LOG;
    case 'metric':
      return KIND_METRIC;
    case 'span':
      return KIND_SPAN;
  }
}

function encodeEventBody(w: ByteWriter, event: Event): void {
  w.writeUint8(kindByte(event));
  encodeMetadata(w, event.metadata);
  switch (event.kind) {
    case 'log':
      encodeObjectBody(w, event.fields);
      return;
    case 'metric':
      encodeMetricBody(w, event);
      return;
    case 'span':
      encodeSpanBody(w, event);
      return;
  }
}

function decodeEventBody(r: ByteReader, limits: ResolvedLimits): Event {
  const kind = r.readUint8();
  const metadata = decodeMetadata(r, limits);
  switch (kind) {
    case KIND_LOG:
      return new LogEvent(decodeObjectBody(r, limits, 1), metadata);
    case KIND_METRIC:
      return decodeMetricBody(r, limits, metadata);
    case KIND_SPAN:
      return decodeSpanBody(r, limits, metadata);
    default:
      throw new CodecMalformedError(`unknown event kind: ${kind}`);
  }
}

// --- Metadata (excludes finalizers: they do not survive persistence) --------------------------

function encodeMetadata(w: ByteWriter, metadata: EventMetadata): void {
  writeOptionalString(w, metadata.sourceId);
  writeOptionalString(w, metadata.sourceType);
  w.writeZigzagBig(metadata.receivedAt.nanos);
}

function decodeMetadata(r: ByteReader, limits: ResolvedLimits): EventMetadata {
  const sourceId = readOptionalString(r, limits);
  const sourceType = readOptionalString(r, limits);
  const receivedAt = Timestamp.fromNanos(r.readZigzagBig());
  const init: MetadataInit = { receivedAt };
  if (sourceId !== undefined) init.sourceId = sourceId;
  if (sourceType !== undefined) init.sourceType = sourceType;
  return createMetadata(init);
}

// --- Values --------------------------------------------------------------------------------

function encodeValue(w: ByteWriter, value: Value): void {
  switch (typeof value) {
    case 'boolean':
      w.writeUint8(value ? TAG_TRUE : TAG_FALSE);
      return;
    case 'bigint':
      w.writeUint8(TAG_INTEGER);
      w.writeZigzagBig(value);
      return;
    case 'number':
      w.writeUint8(TAG_FLOAT);
      w.writeFloat64LE(value);
      return;
    case 'string':
      w.writeUint8(TAG_STRING);
      w.writeString(value);
      return;
    case 'object': {
      if (value === null) {
        w.writeUint8(TAG_NULL);
        return;
      }
      if (value instanceof Timestamp) {
        w.writeUint8(TAG_TIMESTAMP);
        w.writeZigzagBig(value.nanos);
        return;
      }
      if (value instanceof Map) {
        w.writeUint8(TAG_OBJECT);
        encodeObjectBody(w, value);
        return;
      }
      if (Array.isArray(value)) {
        w.writeUint8(TAG_ARRAY);
        encodeArrayBody(w, value);
        return;
      }
      w.writeUint8(TAG_BYTES);
      w.writeLengthPrefixed(value);
      return;
    }
    default:
      throw new CodecMalformedError(`cannot encode a ${typeof value} as a Ferrule value`);
  }
}

function decodeValue(r: ByteReader, limits: ResolvedLimits, depth: number): Value {
  const tag = r.readUint8();
  switch (tag) {
    case TAG_NULL:
      return null;
    case TAG_FALSE:
      return false;
    case TAG_TRUE:
      return true;
    case TAG_INTEGER:
      return r.readZigzagBig();
    case TAG_FLOAT:
      return r.readFloat64LE();
    case TAG_STRING:
      return r.readString(limits.maxStringBytes);
    case TAG_BYTES:
      return r.readLengthPrefixed(limits.maxBytesLength);
    case TAG_TIMESTAMP:
      return Timestamp.fromNanos(r.readZigzagBig());
    case TAG_ARRAY:
      return decodeArrayBody(r, limits, depth);
    case TAG_OBJECT:
      return decodeObjectBody(r, limits, depth);
    default:
      throw new CodecMalformedError(`unknown value tag: ${tag}`);
  }
}

function encodeObjectBody(w: ByteWriter, map: ValueMap): void {
  w.writeVarint(map.size);
  for (const [key, value] of map) {
    w.writeString(key);
    encodeValue(w, value);
  }
}

function decodeObjectBody(r: ByteReader, limits: ResolvedLimits, depth: number): ValueMap {
  if (depth > limits.maxDepth) throw new CodecLimitExceededError('value.depth', limits.maxDepth);
  const count = readCount(r, limits.maxCollectionLength, 'object.size');
  const out: ValueMap = new Map();
  for (let i = 0; i < count; i++) {
    const key = r.readString(limits.maxStringBytes);
    out.set(key, decodeValue(r, limits, depth + 1));
  }
  return out;
}

function encodeArrayBody(w: ByteWriter, values: readonly Value[]): void {
  w.writeVarint(values.length);
  for (const value of values) encodeValue(w, value);
}

function decodeArrayBody(r: ByteReader, limits: ResolvedLimits, depth: number): Value[] {
  if (depth > limits.maxDepth) throw new CodecLimitExceededError('value.depth', limits.maxDepth);
  const count = readCount(r, limits.maxCollectionLength, 'array.length');
  const out: Value[] = [];
  for (let i = 0; i < count; i++) out.push(decodeValue(r, limits, depth + 1));
  return out;
}

// --- Metrics -------------------------------------------------------------------------------

type MetricEventInit = ConstructorParameters<typeof MetricEvent>[0];

function encodeMetricBody(w: ByteWriter, event: MetricEvent): void {
  w.writeString(event.series.name);
  writeOptionalString(w, event.series.namespace);
  w.writeVarint(event.series.tags.size);
  for (const [key, value] of event.series.tags) {
    w.writeString(key);
    w.writeString(value);
  }
  w.writeUint8(event.metricKind === 'incremental' ? 0 : 1);
  encodeMetricValue(w, event.value);
  if (event.timestamp === undefined) {
    w.writeUint8(0);
  } else {
    w.writeUint8(1);
    w.writeZigzagBig(event.timestamp.nanos);
  }
  if (event.intervalMs === undefined) {
    w.writeUint8(0);
  } else {
    w.writeUint8(1);
    w.writeFloat64LE(event.intervalMs);
  }
}

function decodeMetricBody(
  r: ByteReader,
  limits: ResolvedLimits,
  metadata: EventMetadata,
): MetricEvent {
  const name = r.readString(limits.maxStringBytes);
  const namespace = readOptionalString(r, limits);
  const tagCount = readCount(r, limits.maxCollectionLength, 'metric.tags.length');
  const tags = new Map<string, string>();
  for (let i = 0; i < tagCount; i++) {
    const key = r.readString(limits.maxStringBytes);
    const value = r.readString(limits.maxStringBytes);
    tags.set(key, value);
  }
  const kindByteValue = r.readUint8();
  if (kindByteValue !== 0 && kindByteValue !== 1) {
    throw new CodecMalformedError(`invalid metric kind: ${kindByteValue}`);
  }
  const value = decodeMetricValue(r, limits);
  const hasTimestamp = r.readUint8();
  const timestamp = hasTimestamp === 0 ? undefined : Timestamp.fromNanos(r.readZigzagBig());
  const hasInterval = r.readUint8();
  const intervalMs = hasInterval === 0 ? undefined : r.readFloat64LE();

  const init: MetricEventInit = {
    name,
    tags,
    kind: kindByteValue === 0 ? 'incremental' : 'absolute',
    value,
    metadata,
  };
  if (namespace !== undefined) init.namespace = namespace;
  if (timestamp !== undefined) init.timestamp = timestamp;
  if (intervalMs !== undefined) init.intervalMs = intervalMs;
  return new MetricEvent(init);
}

function encodeMetricValue(w: ByteWriter, value: MetricValue): void {
  switch (value.type) {
    case 'counter':
      w.writeUint8(METRIC_COUNTER);
      w.writeFloat64LE(value.value);
      return;
    case 'gauge':
      w.writeUint8(METRIC_GAUGE);
      w.writeFloat64LE(value.value);
      return;
    case 'set':
      w.writeUint8(METRIC_SET);
      w.writeVarint(value.values.size);
      for (const v of value.values) w.writeString(v);
      return;
    case 'distribution':
      w.writeUint8(METRIC_DISTRIBUTION);
      w.writeUint8(value.statistic === 'histogram' ? 0 : 1);
      w.writeVarint(value.samples.length);
      for (const s of value.samples) {
        w.writeFloat64LE(s.value);
        w.writeFloat64LE(s.rate);
      }
      return;
    case 'histogram':
      w.writeUint8(METRIC_HISTOGRAM);
      w.writeVarint(value.buckets.length);
      for (const b of value.buckets) {
        w.writeFloat64LE(b.upperLimit);
        w.writeFloat64LE(b.count);
      }
      w.writeFloat64LE(value.count);
      w.writeFloat64LE(value.sum);
      return;
    case 'summary':
      w.writeUint8(METRIC_SUMMARY);
      w.writeVarint(value.quantiles.length);
      for (const q of value.quantiles) {
        w.writeFloat64LE(q.quantile);
        w.writeFloat64LE(q.value);
      }
      w.writeFloat64LE(value.count);
      w.writeFloat64LE(value.sum);
      return;
  }
}

function decodeMetricValue(r: ByteReader, limits: ResolvedLimits): MetricValue {
  const tag = r.readUint8();
  switch (tag) {
    case METRIC_COUNTER:
      return { type: 'counter', value: r.readFloat64LE() };
    case METRIC_GAUGE:
      return { type: 'gauge', value: r.readFloat64LE() };
    case METRIC_SET: {
      const n = readCount(r, limits.maxCollectionLength, 'metric.set.size');
      const values = new Set<string>();
      for (let i = 0; i < n; i++) values.add(r.readString(limits.maxStringBytes));
      return { type: 'set', values };
    }
    case METRIC_DISTRIBUTION: {
      const statByte = r.readUint8();
      if (statByte !== 0 && statByte !== 1) {
        throw new CodecMalformedError(`invalid distribution statistic: ${statByte}`);
      }
      const n = readCount(r, limits.maxCollectionLength, 'metric.distribution.samples');
      const samples: Sample[] = [];
      for (let i = 0; i < n; i++) {
        samples.push({ value: r.readFloat64LE(), rate: r.readFloat64LE() });
      }
      return { type: 'distribution', statistic: statByte === 0 ? 'histogram' : 'summary', samples };
    }
    case METRIC_HISTOGRAM: {
      const n = readCount(r, limits.maxCollectionLength, 'metric.histogram.buckets');
      const buckets: Bucket[] = [];
      for (let i = 0; i < n; i++) {
        buckets.push({ upperLimit: r.readFloat64LE(), count: r.readFloat64LE() });
      }
      const count = r.readFloat64LE();
      const sum = r.readFloat64LE();
      return { type: 'histogram', buckets, count, sum };
    }
    case METRIC_SUMMARY: {
      const n = readCount(r, limits.maxCollectionLength, 'metric.summary.quantiles');
      const quantiles: Quantile[] = [];
      for (let i = 0; i < n; i++) {
        quantiles.push({ quantile: r.readFloat64LE(), value: r.readFloat64LE() });
      }
      const count = r.readFloat64LE();
      const sum = r.readFloat64LE();
      return { type: 'summary', quantiles, count, sum };
    }
    default:
      throw new CodecMalformedError(`unknown metric value tag: ${tag}`);
  }
}

// --- Spans -----------------------------------------------------------------------------------

function encodeSpanBody(w: ByteWriter, event: SpanEvent): void {
  w.writeRawBytes(event.traceId);
  w.writeRawBytes(event.spanId);
  if (event.parentSpanId === undefined) {
    w.writeUint8(0);
  } else {
    w.writeUint8(1);
    w.writeRawBytes(event.parentSpanId);
  }
  writeOptionalString(w, event.traceState);
  w.writeString(event.name);
  w.writeUint8(SPAN_KIND_BYTES[event.spanKind]);
  w.writeZigzagBig(event.startTime.nanos);
  w.writeZigzagBig(event.endTime.nanos);
  w.writeUint8(STATUS_CODE_BYTES[event.status.code]);
  writeOptionalString(w, event.status.message);
  encodeObjectBody(w, event.attributes);

  w.writeVarint(event.annotations.length);
  for (const a of event.annotations) {
    w.writeString(a.name);
    w.writeZigzagBig(a.time.nanos);
    encodeObjectBody(w, a.attributes);
  }

  w.writeVarint(event.links.length);
  for (const l of event.links) {
    w.writeLengthPrefixed(l.traceId);
    w.writeLengthPrefixed(l.spanId);
    writeOptionalString(w, l.traceState);
    encodeObjectBody(w, l.attributes);
  }

  encodeObjectBody(w, event.resource);

  if (event.scope === undefined) {
    w.writeUint8(0);
  } else {
    w.writeUint8(1);
    w.writeString(event.scope.name);
    writeOptionalString(w, event.scope.version);
    encodeObjectBody(w, event.scope.attributes);
  }
}

function decodeSpanBody(r: ByteReader, limits: ResolvedLimits, metadata: EventMetadata): SpanEvent {
  const traceId = r.readRawBytes(16);
  const spanId = r.readRawBytes(8);
  const hasParent = r.readUint8();
  const parentSpanId = hasParent === 0 ? undefined : r.readRawBytes(8);
  const traceState = readOptionalString(r, limits);
  const name = r.readString(limits.maxStringBytes);
  const spanKindByte = r.readUint8();
  const spanKind = SPAN_KINDS[spanKindByte];
  if (spanKind === undefined) throw new CodecMalformedError(`invalid span kind: ${spanKindByte}`);
  const startTime = Timestamp.fromNanos(r.readZigzagBig());
  const endTime = Timestamp.fromNanos(r.readZigzagBig());
  const statusCodeByte = r.readUint8();
  const statusCode = STATUS_CODES[statusCodeByte];
  if (statusCode === undefined) {
    throw new CodecMalformedError(`invalid span status code: ${statusCodeByte}`);
  }
  const statusMessage = readOptionalString(r, limits);
  const status: SpanStatus =
    statusMessage === undefined
      ? { code: statusCode }
      : { code: statusCode, message: statusMessage };
  const attributes = decodeObjectBody(r, limits, 1);

  const annotationCount = readCount(r, limits.maxCollectionLength, 'span.annotations.length');
  const annotations: SpanAnnotation[] = [];
  for (let i = 0; i < annotationCount; i++) {
    const aName = r.readString(limits.maxStringBytes);
    const aTime = Timestamp.fromNanos(r.readZigzagBig());
    const aAttributes = decodeObjectBody(r, limits, 1);
    annotations.push({ name: aName, time: aTime, attributes: aAttributes });
  }

  const linkCount = readCount(r, limits.maxCollectionLength, 'span.links.length');
  const links: SpanLink[] = [];
  for (let i = 0; i < linkCount; i++) {
    const lTraceId = r.readLengthPrefixed(limits.maxBytesLength);
    const lSpanId = r.readLengthPrefixed(limits.maxBytesLength);
    const lTraceState = readOptionalString(r, limits);
    const lAttributes = decodeObjectBody(r, limits, 1);
    const link: SpanLink = { traceId: lTraceId, spanId: lSpanId, attributes: lAttributes };
    if (lTraceState !== undefined) link.traceState = lTraceState;
    links.push(link);
  }

  const resource = decodeObjectBody(r, limits, 1);

  const hasScope = r.readUint8();
  let scope: InstrumentationScope | undefined;
  if (hasScope !== 0) {
    const sName = r.readString(limits.maxStringBytes);
    const sVersion = readOptionalString(r, limits);
    const sAttributes = decodeObjectBody(r, limits, 1);
    scope =
      sVersion === undefined
        ? { name: sName, attributes: sAttributes }
        : { name: sName, version: sVersion, attributes: sAttributes };
  }

  const init: SpanInit = {
    traceId,
    spanId,
    name,
    spanKind,
    startTime,
    endTime,
    status,
    attributes,
    annotations,
    links,
    resource,
    metadata,
  };
  if (parentSpanId !== undefined) init.parentSpanId = parentSpanId;
  if (traceState !== undefined) init.traceState = traceState;
  if (scope !== undefined) init.scope = scope;
  return new SpanEvent(init);
}

// --- Shared helpers ----------------------------------------------------------------------------

function writeOptionalString(w: ByteWriter, value: string | undefined): void {
  if (value === undefined) {
    w.writeUint8(0);
    return;
  }
  w.writeUint8(1);
  w.writeString(value);
}

function readOptionalString(r: ByteReader, limits: ResolvedLimits): string | undefined {
  return r.readUint8() === 0 ? undefined : r.readString(limits.maxStringBytes);
}

function readCount(r: ByteReader, max: number, what: string): number {
  const n = r.readVarint();
  if (n > max) throw new CodecLimitExceededError(what, max);
  return n;
}
