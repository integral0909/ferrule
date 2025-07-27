import { kindOf, LimitExceededError, Timestamp, type Value, type ValueMap } from '@ferrule/core';
import { forEachField, type ProtoReader, type ProtoWriter } from '../proto/index.js';

/** Shared bounds for decoding OTLP protobuf payloads. */
export interface OtlpDecodeOptions {
  /** Maximum nesting depth of `AnyValue` (arrays/objects inside attributes). Default 32. */
  maxValueDepth?: number;
  /** Maximum number of attributes (or array/object entries) read from a single KeyValue list or
   * ArrayValue/KeyValueList. Default 4096. */
  maxCollectionSize?: number;
}

export interface ResolvedOtlpDecodeOptions {
  maxValueDepth: number;
  maxCollectionSize: number;
}

export function resolveDecodeOptions(options: OtlpDecodeOptions = {}): ResolvedOtlpDecodeOptions {
  return {
    maxValueDepth: options.maxValueDepth ?? 32,
    maxCollectionSize: options.maxCollectionSize ?? 4096,
  };
}

/** `InstrumentationScope`, decoded/represented for round-tripping with `SpanEvent.scope`. */
export interface OtlpScope {
  name: string;
  version?: string;
  attributes: ValueMap;
}

// --- AnyValue -----------------------------------------------------------------------------

/** Decodes an `AnyValue` message body into a core {@link Value}. An AnyValue with none of its
 * oneof fields set (an "empty" value, per the OTLP spec) decodes to `null`. */
export function decodeAnyValue(
  bytes: Uint8Array,
  depth: number,
  options: ResolvedOtlpDecodeOptions,
): Value {
  if (depth > options.maxValueDepth) {
    throw new LimitExceededError(
      'otlp.value.depth',
      options.maxValueDepth,
      'AnyValue nesting too deep',
    );
  }
  let result: Value = null;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        result = r.readString();
        break;
      case 2:
        result = r.readBool();
        break;
      case 3:
        result = r.readInt64();
        break;
      case 4:
        result = r.readDouble();
        break;
      case 5:
        result = decodeArrayValue(r.readBytes(), depth + 1, options);
        break;
      case 6:
        result = decodeKeyValueList(r.readBytes(), depth + 1, options);
        break;
      case 7:
        result = r.readBytes().slice();
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return result;
}

function decodeArrayValue(
  bytes: Uint8Array,
  depth: number,
  options: ResolvedOtlpDecodeOptions,
): Value[] {
  const items: Value[] = [];
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    if (items.length >= options.maxCollectionSize) {
      throw new LimitExceededError(
        'otlp.array.size',
        options.maxCollectionSize,
        'ArrayValue has too many elements',
      );
    }
    items.push(decodeAnyValue(r.readBytes(), depth, options));
  });
  return items;
}

function decodeKeyValueList(
  bytes: Uint8Array,
  depth: number,
  options: ResolvedOtlpDecodeOptions,
): ValueMap {
  const out: ValueMap = new Map();
  forEachField(bytes, (field, wireType, r) => {
    if (field !== 1) {
      r.skipValue(wireType);
      return;
    }
    if (out.size >= options.maxCollectionSize) {
      throw new LimitExceededError(
        'otlp.kvlist.size',
        options.maxCollectionSize,
        'KeyValueList has too many entries',
      );
    }
    const [key, value] = decodeKeyValue(r.readBytes(), depth, options);
    out.set(key, value);
  });
  return out;
}

/** Decodes a `KeyValue` message into a `[key, value]` pair. */
export function decodeKeyValue(
  bytes: Uint8Array,
  depth: number,
  options: ResolvedOtlpDecodeOptions,
): [string, Value] {
  let key = '';
  let value: Value = null;
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        key = r.readString();
        break;
      case 2:
        value = decodeAnyValue(r.readBytes(), depth, options);
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return [key, value];
}

/** Decodes a repeated `KeyValue attributes = N` field's occurrences into a {@link ValueMap},
 * called once per occurrence from the owning message's field loop. */
export function decodeAttributeInto(
  target: ValueMap,
  bytes: Uint8Array,
  options: ResolvedOtlpDecodeOptions,
): void {
  if (target.size >= options.maxCollectionSize) {
    throw new LimitExceededError(
      'otlp.attributes.size',
      options.maxCollectionSize,
      'too many attributes',
    );
  }
  const [key, value] = decodeKeyValue(bytes, 0, options);
  target.set(key, value);
}

/** Encodes `value` as an `AnyValue` message written to field `field` of `w`. */
export function writeAnyValue(w: ProtoWriter, field: number, value: Value): void {
  w.writeMessage(field, (child) => writeAnyValueBody(child, value));
}

function writeAnyValueBody(w: ProtoWriter, value: Value): void {
  switch (kindOf(value)) {
    case 'null':
      return;
    case 'string':
      w.writeString(1, value as string);
      return;
    case 'boolean':
      w.writeBool(2, value as boolean);
      return;
    case 'integer':
      w.writeInt64(3, value as bigint);
      return;
    case 'float':
      w.writeDouble(4, value as number);
      return;
    case 'array':
      w.writeMessage(5, (child) => {
        for (const item of value as Value[]) writeAnyValue(child, 1, item);
      });
      return;
    case 'object':
      w.writeMessage(6, (child) => {
        for (const [k, v] of value as ValueMap) writeKeyValue(child, 1, k, v);
      });
      return;
    case 'bytes':
      w.writeBytes(7, value as Uint8Array);
      return;
    case 'timestamp':
      // AnyValue has no timestamp kind; represented as an RFC 3339 string (documented convention).
      w.writeString(1, (value as Timestamp).toISOString());
      return;
  }
}

export function writeKeyValue(w: ProtoWriter, field: number, key: string, value: Value): void {
  w.writeMessage(field, (child) => {
    child.writeString(1, key);
    writeAnyValue(child, 2, value);
  });
}

/** Writes every entry of `attributes` as a repeated `KeyValue` field. */
export function writeAttributes(w: ProtoWriter, field: number, attributes: ValueMap): void {
  for (const [key, value] of attributes) writeKeyValue(w, field, key, value);
}

// --- Resource / InstrumentationScope -------------------------------------------------------

/** Decodes a `Resource` message's attributes. */
export function decodeResource(bytes: Uint8Array, options: ResolvedOtlpDecodeOptions): ValueMap {
  const attributes: ValueMap = new Map();
  forEachField(bytes, (field, wireType, r) => {
    if (field === 1) decodeAttributeInto(attributes, r.readBytes(), options);
    else r.skipValue(wireType);
  });
  return attributes;
}

export function writeResource(w: ProtoWriter, field: number, resource: ValueMap): void {
  if (resource.size === 0) return;
  w.writeMessage(field, (child) => writeAttributes(child, 1, resource));
}

/** Decodes an `InstrumentationScope` message. */
export function decodeScope(bytes: Uint8Array, options: ResolvedOtlpDecodeOptions): OtlpScope {
  const scope: OtlpScope = { name: '', attributes: new Map() };
  forEachField(bytes, (field, wireType, r) => {
    switch (field) {
      case 1:
        scope.name = r.readString();
        break;
      case 2:
        scope.version = r.readString();
        break;
      case 3:
        decodeAttributeInto(scope.attributes, r.readBytes(), options);
        break;
      default:
        r.skipValue(wireType);
    }
  });
  return scope;
}

export function writeScope(w: ProtoWriter, field: number, scope: OtlpScope | undefined): void {
  if (scope === undefined) return;
  w.writeMessage(field, (child) => {
    child.writeString(1, scope.name);
    if (scope.version !== undefined) child.writeString(2, scope.version);
    writeAttributes(child, 3, scope.attributes);
  });
}

// --- Timestamps -----------------------------------------------------------------------------

/** Reads a `fixed64` UNIX-epoch-nanoseconds field as a {@link Timestamp}, or `undefined` for the
 * all-zero value OTLP uses to mean "unset". */
export function readOptionalTimestamp(r: ProtoReader): Timestamp | undefined {
  const nanos = r.readFixed64();
  return nanos === 0n ? undefined : Timestamp.fromNanos(nanos);
}

export function writeTimestamp(
  w: ProtoWriter,
  field: number,
  timestamp: Timestamp | undefined,
): void {
  if (timestamp === undefined) return;
  w.writeFixed64(field, timestamp.nanos);
}
