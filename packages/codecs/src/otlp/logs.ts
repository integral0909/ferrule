import { createMetadata, LogEvent, Timestamp, type Value, type ValueMap } from '@ferrule/core';
import { forEachField } from '../proto/index.js';
import { ProtoWriter } from '../proto/writer.js';
import {
  decodeAnyValue,
  decodeAttributeInto,
  decodeResource,
  decodeScope,
  type OtlpDecodeOptions,
  type OtlpScope,
  readOptionalTimestamp,
  resolveDecodeOptions,
  writeAnyValue,
  writeAttributes,
  writeResource,
  writeScope,
  writeTimestamp,
} from './common.js';
import { stringifyAttributeValue } from './metrics.js';

/**
 * Mapping between an OTLP `LogRecord` and a core {@link LogEvent}, documented here because it is
 * lossy in both directions by construction (the core log model has no dedicated slots for
 * resource/scope/severity/trace-context, only a field map):
 *
 * | OTLP field                    | `LogEvent` field                                         |
 * | ------------------------------ | --------------------------------------------------------- |
 * | `time_unix_nano`               | `.timestamp` (falls back to `observed_time_unix_nano`)   |
 * | `observed_time_unix_nano`      | `.observed_timestamp` (only if set and nonzero)          |
 * | `severity_number`               | `.severity_number` (integer, omitted if `0`/unspecified) |
 * | `severity_text`                 | `.severity_text` (omitted if empty)                       |
 * | `body`                          | `.body` (any {@link Value}); a string body is also mirrored to `.message` |
 * | `attributes`                    | `.attributes` (nested object)                              |
 * | `dropped_attributes_count`      | `.dropped_attributes_count` (omitted if `0`)               |
 * | `trace_id` / `span_id`          | `.trace_id` / `.span_id` (bytes, omitted if empty)         |
 * | `Resource.attributes`           | `.resource` (nested object, one per `ResourceLogs`)         |
 * | `InstrumentationScope`          | `.scope` (`{ name, version?, attributes }`)                |
 *
 * Encoding is the inverse: any top-level field of `LogEvent.fields` not in the table above is
 * folded into the encoded record's `attributes` instead of being dropped, so a round trip through
 * `decode(encode(x))` does not lose data added to a log event after decoding.
 */
export function decodeExportLogsServiceRequest(
  bytes: Uint8Array,
  options: OtlpDecodeOptions = {},
): LogEvent[] {
  const resolved = resolveDecodeOptions(options);
  const events: LogEvent[] = [];
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    decodeResourceLogs(r.readBytes(), resolved, events);
  });
  return events;
}

function decodeResourceLogs(
  bytes: Uint8Array,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: LogEvent[],
): void {
  let resource: ValueMap = new Map();
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        resource = decodeResource(r.readBytes(), options);
        break;
      case 2:
        decodeScopeLogs(r.readBytes(), resource, options, out);
        break;
      default:
        r.skipValue(wireType);
    }
  });
}

function decodeScopeLogs(
  bytes: Uint8Array,
  resource: ValueMap,
  options: ReturnType<typeof resolveDecodeOptions>,
  out: LogEvent[],
): void {
  let scope: OtlpScope | undefined;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        scope = decodeScope(r.readBytes(), options);
        break;
      case 2:
        out.push(decodeLogRecord(r.readBytes(), resource, scope, options));
        break;
      default:
        r.skipValue(wireType);
    }
  });
}

function decodeLogRecord(
  bytes: Uint8Array,
  resource: ValueMap,
  scope: OtlpScope | undefined,
  options: ReturnType<typeof resolveDecodeOptions>,
): LogEvent {
  const fields: ValueMap = new Map();
  let time: Timestamp | undefined;
  let observedTime: Timestamp | undefined;
  let severityNumber = 0;
  let severityText = '';
  let body: Value = null;
  const attributes: ValueMap = new Map();
  let droppedAttributes = 0;
  let traceId: Uint8Array | undefined;
  let spanId: Uint8Array | undefined;

  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        time = readOptionalTimestamp(r);
        break;
      case 2:
        severityNumber = r.readInt32();
        break;
      case 3:
        severityText = r.readString();
        break;
      case 5:
        body = decodeAnyValue(r.readBytes(), 0, options);
        break;
      case 6:
        decodeAttributeInto(attributes, r.readBytes(), options);
        break;
      case 7:
        droppedAttributes = r.readUInt32();
        break;
      case 9:
        traceId = r.readBytes().slice();
        break;
      case 10:
        spanId = r.readBytes().slice();
        break;
      case 11:
        observedTime = readOptionalTimestamp(r);
        break;
      default:
        r.skipValue(wireType);
    }
  });

  fields.set('timestamp', time ?? observedTime ?? Timestamp.now());
  if (observedTime !== undefined) fields.set('observed_timestamp', observedTime);
  if (severityNumber !== 0) fields.set('severity_number', BigInt(severityNumber));
  if (severityText !== '') fields.set('severity_text', severityText);
  if (body !== null) {
    fields.set('body', body);
    if (typeof body === 'string') fields.set('message', body);
  }
  if (attributes.size > 0) fields.set('attributes', attributes);
  if (droppedAttributes !== 0) fields.set('dropped_attributes_count', BigInt(droppedAttributes));
  if (traceId !== undefined && traceId.length > 0) fields.set('trace_id', traceId);
  if (spanId !== undefined && spanId.length > 0) fields.set('span_id', spanId);
  if (resource.size > 0) fields.set('resource', resource);
  if (scope !== undefined) fields.set('scope', scopeToValue(scope));

  return new LogEvent(fields, createMetadata());
}

function scopeToValue(scope: OtlpScope): ValueMap {
  const v: ValueMap = new Map();
  v.set('name', scope.name);
  if (scope.version !== undefined) v.set('version', scope.version);
  v.set('attributes', scope.attributes);
  return v;
}

const RESERVED_LOG_FIELDS = new Set([
  'timestamp',
  'observed_timestamp',
  'severity_number',
  'severity_text',
  'body',
  'message',
  'attributes',
  'dropped_attributes_count',
  'trace_id',
  'span_id',
  'resource',
  'scope',
]);

export interface EncodeLogsOptions {
  /** Maximum number of `LogEvent`s to encode into one request. Default unlimited. */
  maxEvents?: number;
}

/** Encodes `events` into one `ExportLogsServiceRequest`, grouping by resource and scope. */
export function encodeExportLogsServiceRequest(
  events: readonly LogEvent[],
  options: EncodeLogsOptions = {},
): Uint8Array {
  if (options.maxEvents !== undefined && events.length > options.maxEvents) {
    throw new RangeError(
      `cannot encode ${events.length} events, exceeding maxEvents (${options.maxEvents})`,
    );
  }
  const w = new ProtoWriter();
  const groups = groupByResourceAndScope(events);
  for (const group of groups.values()) {
    w.writeMessage(1, (rl) => {
      writeResource(rl, 1, group.resource);
      rl.writeMessage(2, (sl) => {
        writeScope(sl, 1, group.scope);
        for (const event of group.events) sl.writeMessage(2, (rec) => writeLogRecord(rec, event));
      });
    });
  }
  return w.finish();
}

interface Group {
  resource: ValueMap;
  scope: OtlpScope | undefined;
  events: LogEvent[];
}

function groupByResourceAndScope(events: readonly LogEvent[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const event of events) {
    const resource = asValueMap(event.get('resource')) ?? new Map<string, Value>();
    const scope = valueToScope(event.get('scope'));
    const key = `${stableKey(resource)}\u0000${scope === undefined ? '' : `${scope.name}\u0000${scope.version ?? ''}\u0000${stableKey(scope.attributes)}`}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { resource, scope, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return groups;
}

function stableKey(map: ValueMap): string {
  const keys = [...map.keys()].sort();
  return keys.map((k) => `${k}=${stringifyAttributeValue(map.get(k)!)}`).join('\u0001');
}

function asValueMap(value: Value | undefined): ValueMap | undefined {
  return value instanceof Map ? value : undefined;
}

function valueToScope(value: Value | undefined): OtlpScope | undefined {
  if (!(value instanceof Map)) return undefined;
  const name = value.get('name');
  const version = value.get('version');
  const attributes = value.get('attributes');
  return {
    name: typeof name === 'string' ? name : '',
    attributes: attributes instanceof Map ? attributes : new Map<string, Value>(),
    ...(typeof version === 'string' ? { version } : {}),
  };
}

function writeLogRecord(w: ProtoWriter, event: LogEvent): void {
  const timestamp = event.get('timestamp');
  if (timestamp instanceof Timestamp) writeTimestamp(w, 1, timestamp);
  const observed = event.get('observed_timestamp');
  if (observed instanceof Timestamp) writeTimestamp(w, 11, observed);

  const severityNumber = event.get('severity_number');
  if (typeof severityNumber === 'bigint') w.writeInt32(2, Number(severityNumber));
  const severityText = event.get('severity_text');
  if (typeof severityText === 'string') w.writeString(3, severityText);

  const body =
    event.get('body') ??
    (typeof event.get('message') === 'string' ? event.get('message')! : undefined);
  if (body !== undefined) writeAnyValue(w, 5, body);

  const attributes: ValueMap = new Map(asValueMap(event.get('attributes')) ?? []);
  for (const [key, value] of event.fields) {
    if (!RESERVED_LOG_FIELDS.has(key)) attributes.set(key, value);
  }
  writeAttributes(w, 6, attributes);

  const dropped = event.get('dropped_attributes_count');
  if (typeof dropped === 'bigint' && dropped !== 0n) w.writeUInt32(7, Number(dropped));

  const traceId = event.get('trace_id');
  if (traceId instanceof Uint8Array) w.writeBytes(9, traceId);
  const spanId = event.get('span_id');
  if (spanId instanceof Uint8Array) w.writeBytes(10, spanId);
}
