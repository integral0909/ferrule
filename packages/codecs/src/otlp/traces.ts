import {
  createMetadata,
  SpanEvent,
  Timestamp,
  type SpanAnnotation,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  type ValueMap,
} from '@ferrule/core';
import { forEachField } from '../proto/index.js';
import { ProtoWriter } from '../proto/writer.js';
import {
  decodeAttributeInto,
  decodeResource,
  decodeScope,
  type OtlpDecodeOptions,
  type OtlpScope,
  readOptionalTimestamp,
  resolveDecodeOptions,
  writeAttributes,
  writeResource,
  writeScope,
  writeTimestamp,
} from './common.js';
import { stringifyAttributeValue } from './metrics.js';

const SPAN_KINDS: readonly SpanKind[] = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];
const SPAN_KIND_NUMBERS: Readonly<Record<SpanKind, number>> = {
  unspecified: 0,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const STATUS_CODES: readonly SpanStatus['code'][] = ['unset', 'ok', 'error'];
const STATUS_CODE_NUMBERS: Readonly<Record<SpanStatus['code'], number>> = {
  unset: 0,
  ok: 1,
  error: 2,
};

const EMPTY_TRACE_ID = new Uint8Array(16);
const EMPTY_SPAN_ID = new Uint8Array(8);

/**
 * Decodes an `ExportTraceServiceRequest` into {@link SpanEvent}s. The mapping to OTLP's `Span`
 * message is close to direct: `SpanEvent` carries `resource` and `scope` per span (each span in a
 * `ScopeSpans` gets a copy). `dropped_*_count` fields and `flags` have no home in the core model
 * and are discarded on decode (encoding always writes zero for them).
 */
export function decodeExportTraceServiceRequest(
  bytes: Uint8Array,
  options: OtlpDecodeOptions = {},
): SpanEvent[] {
  const resolved = resolveDecodeOptions(options);
  const spans: SpanEvent[] = [];
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    decodeResourceSpans(r.readBytes(), resolved, spans);
  });
  return spans;
}

function decodeResourceSpans(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: SpanEvent[],
): void {
  let resource: ValueMap = new Map();
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        resource = decodeResource(r.readBytes(), options);
        break;
      case 2:
        decodeScopeSpans(r.readBytes(), resource, options, out);
        break;
      default:
        r.skipValue(wireType);
    }
  });
}

function decodeScopeSpans(
  bytes: Uint8Array,
  resource: ValueMap,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: SpanEvent[],
): void {
  let scope: OtlpScope | undefined;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        scope = decodeScope(r.readBytes(), options);
        break;
      case 2:
        out.push(decodeSpan(r.readBytes(), resource, scope, options));
        break;
      default:
        r.skipValue(wireType);
    }
  });
}

function decodeSpan(
  bytes: Uint8Array,
  resource: ValueMap,
  scope: OtlpScope | undefined,
  options: ReturnType<typeof resolveDecodeOptions>,
): SpanEvent {
  let traceId = EMPTY_TRACE_ID;
  let spanId = EMPTY_SPAN_ID;
  let parentSpanId: Uint8Array | undefined;
  let traceState: string | undefined;
  let name = '';
  let kindNumber = 0;
  let start: Timestamp | undefined;
  let end: Timestamp | undefined;
  const attributes: ValueMap = new Map();
  const annotations: SpanAnnotation[] = [];
  const links: SpanLink[] = [];
  let status: SpanStatus = { code: 'unset' };

  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        traceId = r.readBytes().slice();
        break;
      case 2:
        spanId = r.readBytes().slice();
        break;
      case 3:
        traceState = r.readString();
        break;
      case 4: {
        const bytes4 = r.readBytes();
        if (bytes4.length > 0) parentSpanId = bytes4.slice();
        break;
      }
      case 5:
        name = r.readString();
        break;
      case 6:
        kindNumber = r.readInt32();
        break;
      case 7:
        start = readOptionalTimestamp(r);
        break;
      case 8:
        end = readOptionalTimestamp(r);
        break;
      case 9:
        decodeAttributeInto(attributes, r.readBytes(), options);
        break;
      case 11:
        annotations.push(decodeSpanEvent(r.readBytes(), options));
        break;
      case 13:
        links.push(decodeSpanLink(r.readBytes(), options));
        break;
      case 15:
        status = decodeStatus(r.readBytes());
        break;
      default:
        r.skipValue(wireType);
    }
  });

  // start_time/end_time are semantically required by OTLP; a zero (absent) value falls back to
  // the epoch so a malformed span still decodes to a well-formed SpanEvent.
  const epoch = Timestamp.fromNanos(0n);
  const startTime = start ?? end ?? epoch;
  const endTime = end ?? start ?? epoch;

  return new SpanEvent({
    traceId,
    spanId,
    name,
    spanKind: SPAN_KINDS[kindNumber] ?? 'unspecified',
    startTime,
    endTime,
    status,
    attributes,
    annotations,
    links,
    resource,
    metadata: createMetadata(),
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    ...(traceState !== undefined ? { traceState } : {}),
    ...(scope !== undefined ? { scope } : {}),
  });
}

function decodeSpanEvent(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
): SpanAnnotation {
  let time: Timestamp | undefined;
  let name = '';
  const attributes: ValueMap = new Map();
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        time = readOptionalTimestamp(r);
        break;
      case 2:
        name = r.readString();
        break;
      case 3:
        decodeAttributeInto(attributes, r.readBytes(), options);
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return { name, time: time ?? Timestamp.fromNanos(0n), attributes };
}

function decodeSpanLink(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
): SpanLink {
  let traceId = EMPTY_TRACE_ID;
  let spanId = EMPTY_SPAN_ID;
  let traceState: string | undefined;
  const attributes: ValueMap = new Map();
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        traceId = r.readBytes().slice();
        break;
      case 2:
        spanId = r.readBytes().slice();
        break;
      case 3:
        traceState = r.readString();
        break;
      case 4:
        decodeAttributeInto(attributes, r.readBytes(), options);
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return { traceId, spanId, attributes, ...(traceState !== undefined ? { traceState } : {}) };
}

function decodeStatus(bytes: Uint8Array): SpanStatus {
  let message: string | undefined;
  let code = 0;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 2:
        message = r.readString();
        break;
      case 3:
        code = r.readInt32();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return {
    code: STATUS_CODES[code] ?? 'unset',
    ...(message !== undefined && message !== '' ? { message } : {}),
  };
}

export interface EncodeTracesOptions {
  /** Maximum number of spans to encode into one request. Default unlimited. */
  maxEvents?: number;
}

/** Encodes `spans` into one `ExportTraceServiceRequest`, grouping by resource and scope. */
export function encodeExportTraceServiceRequest(
  spans: readonly SpanEvent[],
  options: EncodeTracesOptions = {},
): Uint8Array {
  if (options.maxEvents !== undefined && spans.length > options.maxEvents) {
    throw new RangeError(
      `cannot encode ${spans.length} spans, exceeding maxEvents (${options.maxEvents})`,
    );
  }
  const w = new ProtoWriter();
  const groups = new Map<
    string,
    { resource: ValueMap; scope: OtlpScope | undefined; spans: SpanEvent[] }
  >();
  for (const span of spans) {
    const key = `${stableKey(span.resource)}\u0000${span.scope === undefined ? '' : `${span.scope.name}\u0000${span.scope.version ?? ''}\u0000${stableKey(span.scope.attributes)}`}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { resource: span.resource, scope: span.scope, spans: [] };
      groups.set(key, group);
    }
    group.spans.push(span);
  }
  for (const group of groups.values()) {
    w.writeMessage(1, (rs) => {
      writeResource(rs, 1, group.resource);
      rs.writeMessage(2, (ss) => {
        writeScope(ss, 1, group.scope);
        for (const span of group.spans) ss.writeMessage(2, (msg) => writeSpan(msg, span));
      });
    });
  }
  return w.finish();
}

function stableKey(map: ValueMap): string {
  return [...map.keys()]
    .sort()
    .map((k) => `${k}=${stringifyAttributeValue(map.get(k)!)}`)
    .join('\u0001');
}

function writeSpan(w: ProtoWriter, span: SpanEvent): void {
  w.writeBytes(1, span.traceId);
  w.writeBytes(2, span.spanId);
  if (span.traceState !== undefined) w.writeString(3, span.traceState);
  if (span.parentSpanId !== undefined) w.writeBytes(4, span.parentSpanId);
  w.writeString(5, span.name);
  w.writeInt32(6, SPAN_KIND_NUMBERS[span.spanKind]);
  writeTimestamp(w, 7, span.startTime);
  writeTimestamp(w, 8, span.endTime);
  writeAttributes(w, 9, span.attributes);
  for (const annotation of span.annotations) {
    w.writeMessage(11, (e) => {
      writeTimestamp(e, 1, annotation.time);
      e.writeString(2, annotation.name);
      writeAttributes(e, 3, annotation.attributes);
    });
  }
  for (const link of span.links) {
    w.writeMessage(13, (l) => {
      l.writeBytes(1, link.traceId);
      l.writeBytes(2, link.spanId);
      if (link.traceState !== undefined) l.writeString(3, link.traceState);
      writeAttributes(l, 4, link.attributes);
    });
  }
  if (
    span.status.code !== 'unset' ||
    (span.status.message !== undefined && span.status.message !== '')
  ) {
    w.writeMessage(15, (s) => {
      if (span.status.message !== undefined) s.writeString(2, span.status.message);
      s.writeInt32(3, STATUS_CODE_NUMBERS[span.status.code]);
    });
  }
}
