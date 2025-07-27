import {
  createMetadata,
  encodeJson,
  fromBase64,
  fromHex,
  kindOf,
  LimitExceededError,
  LogEvent,
  MetricEvent,
  parseJson,
  SpanEvent,
  Timestamp,
  toBase64,
  toHex,
  type Bucket,
  type MetricKind,
  type MetricValue,
  type Quantile,
  type SpanAnnotation,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyAttributeValue } from './metrics.js';

const CODEC = 'otlp-json';

export interface OtlpJsonDecodeOptions {
  /** Maximum nesting depth of `AnyValue` (arrays/objects inside attributes). Default 32. */
  maxValueDepth?: number;
  /** Maximum bytes of JSON text accepted. Default 64 MiB (matches core's JSON parser default). */
  maxLength?: number;
}

interface Resolved {
  maxValueDepth: number;
  maxLength: number | undefined;
}

function resolve(options: OtlpJsonDecodeOptions): Resolved {
  return { maxValueDepth: options.maxValueDepth ?? 32, maxLength: options.maxLength };
}

function fail(message: string): never {
  throw new CodecSyntaxError(CODEC, 'E_OTLP_JSON_SYNTAX', message);
}

// --- generic Value-tree helpers ------------------------------------------------------------

function field(obj: Value | undefined, key: string): Value | undefined {
  return obj instanceof Map ? obj.get(key) : undefined;
}
function str(v: Value | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function bool(v: Value | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function num(v: Value | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}
function int32(v: Value | undefined): number {
  return Math.trunc(num(v) ?? 0);
}
/** Reads an int64/uint64/fixed64 field, encoded per the OTLP JSON mapping as a decimal string
 * (a bare JSON number is also accepted for leniency). */
function int64(v: Value | undefined): bigint {
  if (v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    if (!/^-?\d+$/.test(v)) fail(`expected an integer string, got ${JSON.stringify(v)}`);
    try {
      return BigInt(v);
    } catch {
      return fail(`invalid int64 string ${JSON.stringify(v)}`);
    }
  }
  return fail('expected an integer string');
}
function arr(v: Value | undefined): Value[] {
  return Array.isArray(v) ? v : [];
}
function bytesHex(v: Value | undefined): Uint8Array {
  const s = str(v);
  if (s === undefined || s === '') return new Uint8Array(0);
  try {
    return fromHex(s);
  } catch {
    return fail(`invalid hex byte string ${JSON.stringify(s)}`);
  }
}

function jsonMap(entries: Iterable<[string, Value | undefined]>): ValueMap {
  const m: ValueMap = new Map();
  for (const [k, v] of entries) if (v !== undefined) m.set(k, v);
  return m;
}

// --- AnyValue / KeyValue ---------------------------------------------------------------------

function anyValueToJson(value: Value): ValueMap {
  switch (kindOf(value)) {
    case 'null':
      return new Map();
    case 'string':
      return jsonMap([['stringValue', value]]);
    case 'boolean':
      return jsonMap([['boolValue', value]]);
    case 'integer':
      return jsonMap([['intValue', (value as bigint).toString()]]);
    case 'float':
      return jsonMap([['doubleValue', value]]);
    case 'bytes':
      return jsonMap([['bytesValue', toBase64(value as Uint8Array)]]);
    case 'timestamp':
      return jsonMap([['stringValue', (value as Timestamp).toISOString()]]);
    case 'array':
      return jsonMap([
        ['arrayValue', jsonMap([['values', (value as Value[]).map(anyValueToJson)]])],
      ]);
    case 'object':
      return jsonMap([
        [
          'kvlistValue',
          jsonMap([['values', [...(value as ValueMap)].map(([k, v]) => keyValueToJson(k, v))]]),
        ],
      ]);
  }
}

function keyValueToJson(key: string, value: Value): ValueMap {
  return jsonMap([
    ['key', key],
    ['value', anyValueToJson(value)],
  ]);
}

function jsonToAnyValue(v: Value | undefined, depth: number, options: Resolved): Value {
  if (depth > options.maxValueDepth) {
    throw new LimitExceededError(
      'otlp.value.depth',
      options.maxValueDepth,
      'AnyValue nesting too deep',
    );
  }
  if (!(v instanceof Map)) return null;
  if (v.has('stringValue')) return str(v.get('stringValue')) ?? '';
  if (v.has('boolValue')) return bool(v.get('boolValue')) ?? false;
  if (v.has('intValue')) return int64(v.get('intValue'));
  if (v.has('doubleValue')) return num(v.get('doubleValue')) ?? 0;
  if (v.has('bytesValue')) {
    const s = str(v.get('bytesValue')) ?? '';
    try {
      return fromBase64(s);
    } catch {
      return fail(`invalid base64 bytesValue ${JSON.stringify(s)}`);
    }
  }
  if (v.has('arrayValue')) {
    return arr(field(v.get('arrayValue'), 'values')).map((item) =>
      jsonToAnyValue(item, depth + 1, options),
    );
  }
  if (v.has('kvlistValue')) {
    const out: ValueMap = new Map();
    for (const item of arr(field(v.get('kvlistValue'), 'values'))) {
      out.set(
        str(field(item, 'key')) ?? '',
        jsonToAnyValue(field(item, 'value'), depth + 1, options),
      );
    }
    return out;
  }
  return null;
}

function jsonToAttributes(list: Value | undefined, options: Resolved): ValueMap {
  const out: ValueMap = new Map();
  for (const item of arr(list)) {
    out.set(str(field(item, 'key')) ?? '', jsonToAnyValue(field(item, 'value'), 0, options));
  }
  return out;
}

function attributesToJson(attributes: ValueMap): Value[] {
  return [...attributes].map(([k, v]) => keyValueToJson(k, v));
}

interface JsonScope {
  name: string;
  version?: string;
  attributes: ValueMap;
}

function jsonToScope(v: Value | undefined, options: Resolved): JsonScope | undefined {
  if (!(v instanceof Map)) return undefined;
  const version = str(field(v, 'version'));
  return {
    name: str(field(v, 'name')) ?? '',
    attributes: jsonToAttributes(field(v, 'attributes'), options),
    ...(version !== undefined ? { version } : {}),
  };
}

function scopeToJson(scope: JsonScope | undefined): ValueMap | undefined {
  if (scope === undefined) return undefined;
  return jsonMap([
    ['name', scope.name],
    ['version', scope.version],
    ['attributes', attributesToJson(scope.attributes)],
  ]);
}

function jsonToResource(v: Value | undefined, options: Resolved): ValueMap {
  return jsonToAttributes(field(v, 'attributes'), options);
}

function resourceToJson(resource: ValueMap): ValueMap | undefined {
  if (resource.size === 0) return undefined;
  return jsonMap([['attributes', attributesToJson(resource)]]);
}

function timestampToNanoString(t: Timestamp | undefined): string | undefined {
  return t === undefined ? undefined : t.nanos.toString();
}

// =============================================================================================
// Logs
// =============================================================================================

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

/** Decodes an OTLP/JSON logs export request (`{"resourceLogs": [...]}`) into {@link LogEvent}s.
 * See {@link decodeExportLogsServiceRequest} for the field mapping; it is identical here. */
export function decodeOtlpJsonLogs(text: string, options: OtlpJsonDecodeOptions = {}): LogEvent[] {
  const resolved = resolve(options);
  const root = parseJsonRoot(text, resolved);
  const events: LogEvent[] = [];
  for (const rl of arr(field(root, 'resourceLogs'))) {
    const resource = jsonToResource(field(rl, 'resource'), resolved);
    for (const sl of arr(field(rl, 'scopeLogs'))) {
      const scope = jsonToScope(field(sl, 'scope'), resolved);
      for (const record of arr(field(sl, 'logRecords'))) {
        events.push(decodeLogRecordJson(record, resource, scope, resolved));
      }
    }
  }
  return events;
}

function decodeLogRecordJson(
  record: Value,
  resource: ValueMap,
  scope: JsonScope | undefined,
  options: Resolved,
): LogEvent {
  const fields: ValueMap = new Map();
  const timeNanos = int64(field(record, 'timeUnixNano'));
  const observedNanos = int64(field(record, 'observedTimeUnixNano'));
  const time = timeNanos !== 0n ? Timestamp.fromNanos(timeNanos) : undefined;
  const observed = observedNanos !== 0n ? Timestamp.fromNanos(observedNanos) : undefined;
  fields.set('timestamp', time ?? observed ?? Timestamp.now());
  if (observed !== undefined) fields.set('observed_timestamp', observed);

  const severityNumber = int32(field(record, 'severityNumber'));
  if (severityNumber !== 0) fields.set('severity_number', BigInt(severityNumber));
  const severityText = str(field(record, 'severityText'));
  if (severityText !== undefined && severityText !== '') fields.set('severity_text', severityText);

  const bodyField = field(record, 'body');
  if (bodyField !== undefined) {
    const body = jsonToAnyValue(bodyField, 0, options);
    if (body !== null) {
      fields.set('body', body);
      if (typeof body === 'string') fields.set('message', body);
    }
  }

  const attributes = jsonToAttributes(field(record, 'attributes'), options);
  if (attributes.size > 0) fields.set('attributes', attributes);
  const dropped = int32(field(record, 'droppedAttributesCount'));
  if (dropped !== 0) fields.set('dropped_attributes_count', BigInt(dropped));

  const traceId = bytesHex(field(record, 'traceId'));
  if (traceId.length > 0) fields.set('trace_id', traceId);
  const spanId = bytesHex(field(record, 'spanId'));
  if (spanId.length > 0) fields.set('span_id', spanId);

  if (resource.size > 0) fields.set('resource', resource);
  if (scope !== undefined) {
    fields.set(
      'scope',
      jsonMap([
        ['name', scope.name],
        ['version', scope.version],
        ['attributes', scope.attributes],
      ]),
    );
  }
  return new LogEvent(fields, createMetadata());
}

/** Encodes `events` as an OTLP/JSON logs export request. Grouping mirrors
 * {@link encodeExportLogsServiceRequest}. */
export function encodeOtlpJsonLogs(events: readonly LogEvent[]): string {
  const groups = groupLogsForJson(events);
  const resourceLogs = [...groups.values()].map((group) =>
    jsonMap([
      ['resource', resourceToJson(group.resource) as Value],
      [
        'scopeLogs',
        [
          jsonMap([
            ['scope', scopeToJson(group.scope) as Value],
            ['logRecords', group.events.map(encodeLogRecordJson)],
          ]),
        ],
      ],
    ]),
  );
  return encodeJson(jsonMap([['resourceLogs', resourceLogs]]));
}

interface LogGroup {
  resource: ValueMap;
  scope: JsonScope | undefined;
  events: LogEvent[];
}

function groupLogsForJson(events: readonly LogEvent[]): Map<string, LogGroup> {
  const groups = new Map<string, LogGroup>();
  for (const event of events) {
    const resource = event.get('resource');
    const resourceMap = resource instanceof Map ? resource : new Map<string, Value>();
    const scope = valueToJsonScope(event.get('scope'));
    const key = groupKey(resourceMap, scope);
    let group = groups.get(key);
    if (group === undefined) {
      group = { resource: resourceMap, scope, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return groups;
}

function valueToJsonScope(value: Value | undefined): JsonScope | undefined {
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

function groupKey(resource: ValueMap, scope: JsonScope | undefined): string {
  const scopeKey =
    scope === undefined
      ? ''
      : `${scope.name}\u0000${scope.version ?? ''}\u0000${stableKey(scope.attributes)}`;
  return `${stableKey(resource)}\u0001${scopeKey}`;
}

function stableKey(map: ValueMap): string {
  return [...map.keys()]
    .sort()
    .map((k) => `${k}=${stringifyAttributeValue(map.get(k)!)}`)
    .join('\u0002');
}

function encodeLogRecordJson(event: LogEvent): ValueMap {
  const timestamp = event.get('timestamp');
  const observed = event.get('observed_timestamp');
  const severityNumber = event.get('severity_number');
  const severityText = event.get('severity_text');
  const body =
    event.get('body') ??
    (typeof event.get('message') === 'string' ? event.get('message')! : undefined);
  const existingAttributes = event.get('attributes');
  const attributes: ValueMap = new Map(existingAttributes instanceof Map ? existingAttributes : []);
  for (const [key, value] of event.fields) {
    if (!RESERVED_LOG_FIELDS.has(key)) attributes.set(key, value);
  }
  const dropped = event.get('dropped_attributes_count');
  const traceId = event.get('trace_id');
  const spanId = event.get('span_id');

  return jsonMap([
    ['timeUnixNano', timestamp instanceof Timestamp ? timestampToNanoString(timestamp) : undefined],
    [
      'observedTimeUnixNano',
      observed instanceof Timestamp ? timestampToNanoString(observed) : undefined,
    ],
    ['severityNumber', typeof severityNumber === 'bigint' ? severityNumber : undefined],
    ['severityText', typeof severityText === 'string' ? severityText : undefined],
    ['body', body !== undefined ? anyValueToJson(body) : undefined],
    ['attributes', attributes.size > 0 ? attributesToJson(attributes) : undefined],
    ['droppedAttributesCount', typeof dropped === 'bigint' && dropped !== 0n ? dropped : undefined],
    ['traceId', traceId instanceof Uint8Array && traceId.length > 0 ? toHex(traceId) : undefined],
    ['spanId', spanId instanceof Uint8Array && spanId.length > 0 ? toHex(spanId) : undefined],
  ]);
}

// =============================================================================================
// Traces
// =============================================================================================

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

/** Decodes an OTLP/JSON traces export request into {@link SpanEvent}s. */
export function decodeOtlpJsonTraces(
  text: string,
  options: OtlpJsonDecodeOptions = {},
): SpanEvent[] {
  const resolved = resolve(options);
  const root = parseJsonRoot(text, resolved);
  const spans: SpanEvent[] = [];
  for (const rs of arr(field(root, 'resourceSpans'))) {
    const resource = jsonToResource(field(rs, 'resource'), resolved);
    for (const ss of arr(field(rs, 'scopeSpans'))) {
      const scope = jsonToScope(field(ss, 'scope'), resolved);
      for (const span of arr(field(ss, 'spans'))) {
        spans.push(decodeSpanJson(span, resource, scope, resolved));
      }
    }
  }
  return spans;
}

function decodeSpanJson(
  span: Value,
  resource: ValueMap,
  scope: JsonScope | undefined,
  options: Resolved,
): SpanEvent {
  const traceId = bytesHex(field(span, 'traceId'));
  const spanId = bytesHex(field(span, 'spanId'));
  const parentRaw = bytesHex(field(span, 'parentSpanId'));
  const traceState = str(field(span, 'traceState'));
  const kindNumber = int32(field(span, 'kind'));
  const startNanos = int64(field(span, 'startTimeUnixNano'));
  const endNanos = int64(field(span, 'endTimeUnixNano'));
  const start = startNanos !== 0n ? Timestamp.fromNanos(startNanos) : undefined;
  const end = endNanos !== 0n ? Timestamp.fromNanos(endNanos) : undefined;
  const epoch = Timestamp.fromNanos(0n);

  const attributes = jsonToAttributes(field(span, 'attributes'), options);
  const annotations: SpanAnnotation[] = arr(field(span, 'events')).map((e) => ({
    name: str(field(e, 'name')) ?? '',
    time:
      int64(field(e, 'timeUnixNano')) !== 0n
        ? Timestamp.fromNanos(int64(field(e, 'timeUnixNano')))
        : epoch,
    attributes: jsonToAttributes(field(e, 'attributes'), options),
  }));
  const links: SpanLink[] = arr(field(span, 'links')).map((l) => {
    const linkState = str(field(l, 'traceState'));
    return {
      traceId: bytesHex(field(l, 'traceId')),
      spanId: bytesHex(field(l, 'spanId')),
      attributes: jsonToAttributes(field(l, 'attributes'), options),
      ...(linkState !== undefined ? { traceState: linkState } : {}),
    };
  });
  const statusField = field(span, 'status');
  const statusMessage = str(field(statusField, 'message'));
  const status: SpanStatus = {
    code: STATUS_CODES[int32(field(statusField, 'code'))] ?? 'unset',
    ...(statusMessage !== undefined && statusMessage !== '' ? { message: statusMessage } : {}),
  };

  return new SpanEvent({
    traceId: traceId.length === 16 ? traceId : new Uint8Array(16),
    spanId: spanId.length === 8 ? spanId : new Uint8Array(8),
    name: str(field(span, 'name')) ?? '',
    spanKind: SPAN_KINDS[kindNumber] ?? 'unspecified',
    startTime: start ?? end ?? epoch,
    endTime: end ?? start ?? epoch,
    status,
    attributes,
    annotations,
    links,
    resource,
    metadata: createMetadata(),
    ...(parentRaw.length === 8 ? { parentSpanId: parentRaw } : {}),
    ...(traceState !== undefined ? { traceState } : {}),
    ...(scope !== undefined ? { scope } : {}),
  });
}

/** Encodes `spans` as an OTLP/JSON traces export request. */
export function encodeOtlpJsonTraces(spans: readonly SpanEvent[]): string {
  const groups = new Map<
    string,
    { resource: ValueMap; scope: JsonScope | undefined; spans: SpanEvent[] }
  >();
  for (const span of spans) {
    const key = groupKey(span.resource, span.scope);
    let group = groups.get(key);
    if (group === undefined) {
      group = { resource: span.resource, scope: span.scope, spans: [] };
      groups.set(key, group);
    }
    group.spans.push(span);
  }
  const resourceSpans = [...groups.values()].map((group) =>
    jsonMap([
      ['resource', resourceToJson(group.resource) as Value],
      [
        'scopeSpans',
        [
          jsonMap([
            ['scope', scopeToJson(group.scope) as Value],
            ['spans', group.spans.map(encodeSpanJson)],
          ]),
        ],
      ],
    ]),
  );
  return encodeJson(jsonMap([['resourceSpans', resourceSpans]]));
}

function encodeSpanJson(span: SpanEvent): ValueMap {
  const status =
    span.status.code !== 'unset' ||
    (span.status.message !== undefined && span.status.message !== '')
      ? jsonMap([
          ['message', span.status.message],
          ['code', BigInt(STATUS_CODE_NUMBERS[span.status.code])],
        ])
      : undefined;
  return jsonMap([
    ['traceId', toHex(span.traceId)],
    ['spanId', toHex(span.spanId)],
    ['traceState', span.traceState],
    ['parentSpanId', span.parentSpanId !== undefined ? toHex(span.parentSpanId) : undefined],
    ['name', span.name],
    ['kind', BigInt(SPAN_KIND_NUMBERS[span.spanKind])],
    ['startTimeUnixNano', timestampToNanoString(span.startTime)],
    ['endTimeUnixNano', timestampToNanoString(span.endTime)],
    ['attributes', span.attributes.size > 0 ? attributesToJson(span.attributes) : undefined],
    [
      'events',
      span.annotations.length > 0
        ? span.annotations.map((a) =>
            jsonMap([
              ['timeUnixNano', timestampToNanoString(a.time)],
              ['name', a.name],
              ['attributes', a.attributes.size > 0 ? attributesToJson(a.attributes) : undefined],
            ]),
          )
        : undefined,
    ],
    [
      'links',
      span.links.length > 0
        ? span.links.map((l) =>
            jsonMap([
              ['traceId', toHex(l.traceId)],
              ['spanId', toHex(l.spanId)],
              ['traceState', l.traceState],
              ['attributes', l.attributes.size > 0 ? attributesToJson(l.attributes) : undefined],
            ]),
          )
        : undefined,
    ],
    ['status', status],
  ]);
}

// =============================================================================================
// Metrics
// =============================================================================================

const TEMPORALITY_DELTA = 1;
const TEMPORALITY_CUMULATIVE = 2;

/** Decodes an OTLP/JSON metrics export request into {@link MetricEvent}s. See
 * {@link decodeExportMetricsServiceRequest} for the (identical) field mapping. */
export function decodeOtlpJsonMetrics(
  text: string,
  options: OtlpJsonDecodeOptions = {},
): MetricEvent[] {
  const resolved = resolve(options);
  const root = parseJsonRoot(text, resolved);
  const events: MetricEvent[] = [];
  for (const rm of arr(field(root, 'resourceMetrics'))) {
    const resourceTags = tagsFromAttributes(jsonToResource(field(rm, 'resource'), resolved));
    for (const sm of arr(field(rm, 'scopeMetrics'))) {
      const scope = jsonToScope(field(sm, 'scope'), resolved);
      const scopeTags = new Map<string, string>();
      if (scope !== undefined) {
        if (scope.name !== '') scopeTags.set('otel.scope.name', scope.name);
        if (scope.version !== undefined) scopeTags.set('otel.scope.version', scope.version);
        for (const [k, v] of tagsFromAttributes(scope.attributes)) scopeTags.set(k, v);
      }
      const baseTags = new Map([...resourceTags, ...scopeTags]);
      for (const metric of arr(field(sm, 'metrics'))) {
        decodeMetricJson(metric, baseTags, resolved, events);
      }
    }
  }
  return events;
}

function tagsFromAttributes(attributes: ValueMap): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [k, v] of attributes) tags.set(k, stringifyAttributeValue(v));
  return tags;
}

function decodeMetricJson(
  metric: Value,
  baseTags: Map<string, string>,
  options: Resolved,
  out: MetricEvent[],
): void {
  const name = str(field(metric, 'name')) ?? '';
  const gauge = field(metric, 'gauge');
  const sum = field(metric, 'sum');
  const histogram = field(metric, 'histogram');
  const summary = field(metric, 'summary');
  if (gauge !== undefined) {
    for (const dp of arr(field(gauge, 'dataPoints'))) {
      const p = decodeNumberDataPointJson(dp, baseTags, options);
      out.push(buildMetricEvent(name, p.tags, 'absolute', { type: 'gauge', value: p.value }, p));
    }
  }
  if (sum !== undefined) {
    const temporality = int32(field(sum, 'aggregationTemporality'));
    const monotonic = bool(field(sum, 'isMonotonic')) ?? false;
    const kind: MetricKind = temporality === TEMPORALITY_DELTA ? 'incremental' : 'absolute';
    const valueType = monotonic ? 'counter' : 'gauge';
    for (const dp of arr(field(sum, 'dataPoints'))) {
      const p = decodeNumberDataPointJson(dp, baseTags, options);
      out.push(buildMetricEvent(name, p.tags, kind, { type: valueType, value: p.value }, p));
    }
  }
  if (histogram !== undefined) {
    const temporality = int32(field(histogram, 'aggregationTemporality'));
    const kind: MetricKind = temporality === TEMPORALITY_DELTA ? 'incremental' : 'absolute';
    for (const dp of arr(field(histogram, 'dataPoints'))) {
      const p = decodeHistogramDataPointJson(dp, options);
      const tags = mergeTags(baseTags, p.attrs);
      out.push(
        buildMetricEvent(
          name,
          tags,
          kind,
          { type: 'histogram', buckets: p.buckets, count: p.count, sum: p.sum },
          p,
        ),
      );
    }
  }
  if (summary !== undefined) {
    for (const dp of arr(field(summary, 'dataPoints'))) {
      const p = decodeSummaryDataPointJson(dp, options);
      const tags = mergeTags(baseTags, p.attrs);
      out.push(
        buildMetricEvent(
          name,
          tags,
          'absolute',
          { type: 'summary', quantiles: p.quantiles, count: p.count, sum: p.sum },
          p,
        ),
      );
    }
  }
}

function mergeTags(base: Map<string, string>, attrs: ValueMap): Map<string, string> {
  const tags = new Map(base);
  for (const [k, v] of tagsFromAttributes(attrs)) tags.set(k, v);
  return tags;
}

interface NumberPointJson {
  tags: Map<string, string>;
  startTime?: Timestamp;
  time?: Timestamp;
  value: number;
}

function decodeNumberDataPointJson(
  dp: Value,
  baseTags: Map<string, string>,
  options: Resolved,
): NumberPointJson {
  const attrs = jsonToAttributes(field(dp, 'attributes'), options);
  const startNanos = int64(field(dp, 'startTimeUnixNano'));
  const timeNanos = int64(field(dp, 'timeUnixNano'));
  const asDouble = field(dp, 'asDouble');
  const asInt = field(dp, 'asInt');
  const value =
    asDouble !== undefined ? (num(asDouble) ?? 0) : asInt !== undefined ? Number(int64(asInt)) : 0;
  return {
    tags: mergeTags(baseTags, attrs),
    ...(startNanos !== 0n ? { startTime: Timestamp.fromNanos(startNanos) } : {}),
    ...(timeNanos !== 0n ? { time: Timestamp.fromNanos(timeNanos) } : {}),
    value,
  };
}

function decodeHistogramDataPointJson(dp: Value, options: Resolved) {
  const attrs = jsonToAttributes(field(dp, 'attributes'), options);
  const startNanos = int64(field(dp, 'startTimeUnixNano'));
  const timeNanos = int64(field(dp, 'timeUnixNano'));
  const count = Number(int64(field(dp, 'count')));
  const sum = num(field(dp, 'sum')) ?? 0;
  const bucketCounts = arr(field(dp, 'bucketCounts')).map((v) =>
    Number(typeof v === 'bigint' ? v : (num(v) ?? 0)),
  );
  const explicitBounds = arr(field(dp, 'explicitBounds')).map((v) => num(v) ?? 0);
  const buckets: Bucket[] = explicitBounds.map((upperLimit, i) => ({
    upperLimit,
    count: bucketCounts[i] ?? 0,
  }));
  return {
    attrs,
    ...(startNanos !== 0n ? { startTime: Timestamp.fromNanos(startNanos) } : {}),
    ...(timeNanos !== 0n ? { time: Timestamp.fromNanos(timeNanos) } : {}),
    count,
    sum,
    buckets,
  };
}

function decodeSummaryDataPointJson(dp: Value, options: Resolved) {
  const attrs = jsonToAttributes(field(dp, 'attributes'), options);
  const startNanos = int64(field(dp, 'startTimeUnixNano'));
  const timeNanos = int64(field(dp, 'timeUnixNano'));
  const count = Number(int64(field(dp, 'count')));
  const sum = num(field(dp, 'sum')) ?? 0;
  const quantiles: Quantile[] = arr(field(dp, 'quantileValues')).map((q) => ({
    quantile: num(field(q, 'quantile')) ?? 0,
    value: num(field(q, 'value')) ?? 0,
  }));
  return {
    attrs,
    ...(startNanos !== 0n ? { startTime: Timestamp.fromNanos(startNanos) } : {}),
    ...(timeNanos !== 0n ? { time: Timestamp.fromNanos(timeNanos) } : {}),
    count,
    sum,
    quantiles,
  };
}

function buildMetricEvent(
  name: string,
  tags: Map<string, string>,
  kind: MetricKind,
  value: MetricValue,
  point: { startTime?: Timestamp; time?: Timestamp },
): MetricEvent {
  const init: ConstructorParameters<typeof MetricEvent>[0] = {
    name,
    tags,
    kind,
    value,
    metadata: createMetadata(),
  };
  if (point.time !== undefined) init.timestamp = point.time;
  if (point.startTime !== undefined && point.time !== undefined) {
    const intervalNanos = point.time.since(point.startTime);
    if (intervalNanos > 0n) init.intervalMs = Number(intervalNanos / 1_000_000n);
  }
  return new MetricEvent(init);
}

/** Encodes `events` as an OTLP/JSON metrics export request. `set` and `distribution` values raise
 * `E_OTLP_UNSUPPORTED_METRIC_TYPE`, matching {@link encodeExportMetricsServiceRequest}. */
export function encodeOtlpJsonMetrics(events: readonly MetricEvent[]): string {
  const groups = new Map<string, MetricEvent[]>();
  for (const event of events) {
    if (event.value.type === 'set' || event.value.type === 'distribution') {
      throw new CodecSyntaxError(
        CODEC,
        'E_OTLP_UNSUPPORTED_METRIC_TYPE',
        `OTLP has no representation for metric value type ${JSON.stringify(event.value.type)}`,
      );
    }
    const fullName =
      event.series.namespace !== undefined
        ? `${event.series.namespace}.${event.series.name}`
        : event.series.name;
    const key = `${fullName}\u0000${event.value.type}\u0000${event.value.type === 'counter' || event.value.type === 'gauge' ? event.metricKind : ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(event);
  }
  const metrics = [...groups.values()].map(encodeMetricJson);
  const root = jsonMap([
    ['resourceMetrics', [jsonMap([['scopeMetrics', [jsonMap([['metrics', metrics]])]]])]],
  ]);
  return encodeJson(root);
}

function encodeMetricJson(group: readonly MetricEvent[]): ValueMap {
  const first = group[0]!;
  const out: ValueMap = new Map([['name', first.series.name]]);
  switch (first.value.type) {
    case 'gauge':
      out.set('gauge', jsonMap([['dataPoints', group.map((e) => encodeNumberPointJson(e))]]));
      return out;
    case 'counter':
      out.set(
        'sum',
        jsonMap([
          ['dataPoints', group.map((e) => encodeNumberPointJson(e))],
          [
            'aggregationTemporality',
            BigInt(first.metricKind === 'incremental' ? TEMPORALITY_DELTA : TEMPORALITY_CUMULATIVE),
          ],
          ['isMonotonic', true],
        ]),
      );
      return out;
    case 'histogram':
      out.set(
        'histogram',
        jsonMap([
          [
            'dataPoints',
            group.map((e) =>
              encodeHistogramPointJson(e, e.value as Extract<MetricValue, { type: 'histogram' }>),
            ),
          ],
          [
            'aggregationTemporality',
            BigInt(first.metricKind === 'incremental' ? TEMPORALITY_DELTA : TEMPORALITY_CUMULATIVE),
          ],
        ]),
      );
      return out;
    case 'summary':
      out.set(
        'summary',
        jsonMap([
          [
            'dataPoints',
            group.map((e) =>
              encodeSummaryPointJson(e, e.value as Extract<MetricValue, { type: 'summary' }>),
            ),
          ],
        ]),
      );
      return out;
    case 'set':
    case 'distribution':
      return out;
  }
}

function tagsToAttributesJson(tags: Map<string, string>): Value[] {
  const attrs: ValueMap = new Map();
  for (const [k, v] of tags) attrs.set(k, v);
  return attributesToJson(attrs);
}

function pointTimestamps(event: MetricEvent): [string | undefined, string | undefined] {
  const time = event.timestamp ?? Timestamp.now();
  const start =
    event.intervalMs !== undefined
      ? Timestamp.fromNanos(time.nanos - BigInt(event.intervalMs) * 1_000_000n)
      : undefined;
  return [timestampToNanoString(time), timestampToNanoString(start)];
}

function encodeNumberPointJson(event: MetricEvent): ValueMap {
  const [time, start] = pointTimestamps(event);
  const value = event.value as Extract<MetricValue, { type: 'gauge' | 'counter' }>;
  return jsonMap([
    [
      'attributes',
      event.series.tags.size > 0 ? tagsToAttributesJson(event.series.tags) : undefined,
    ],
    ['startTimeUnixNano', start],
    ['timeUnixNano', time],
    ['asDouble', value.value],
  ]);
}

function encodeHistogramPointJson(
  event: MetricEvent,
  value: Extract<MetricValue, { type: 'histogram' }>,
): ValueMap {
  const [time, start] = pointTimestamps(event);
  const observed = value.buckets.reduce((s, b) => s + b.count, 0);
  const overflow = Math.max(0, value.count - observed);
  return jsonMap([
    [
      'attributes',
      event.series.tags.size > 0 ? tagsToAttributesJson(event.series.tags) : undefined,
    ],
    ['startTimeUnixNano', start],
    ['timeUnixNano', time],
    ['count', BigInt(Math.round(value.count))],
    ['sum', value.sum],
    [
      'bucketCounts',
      [...value.buckets.map((b) => BigInt(Math.round(b.count))), BigInt(Math.round(overflow))],
    ],
    ['explicitBounds', value.buckets.map((b) => b.upperLimit)],
  ]);
}

function encodeSummaryPointJson(
  event: MetricEvent,
  value: Extract<MetricValue, { type: 'summary' }>,
): ValueMap {
  const [time, start] = pointTimestamps(event);
  return jsonMap([
    [
      'attributes',
      event.series.tags.size > 0 ? tagsToAttributesJson(event.series.tags) : undefined,
    ],
    ['startTimeUnixNano', start],
    ['timeUnixNano', time],
    ['count', BigInt(Math.round(value.count))],
    ['sum', value.sum],
    [
      'quantileValues',
      value.quantiles.map((q) =>
        jsonMap([
          ['quantile', q.quantile],
          ['value', q.value],
        ]),
      ),
    ],
  ]);
}

// --- shared -----------------------------------------------------------------------------------

function parseJsonRoot(text: string, options: Resolved): Value {
  const parseOptions = options.maxLength !== undefined ? { maxLength: options.maxLength } : {};
  const value = parseJson(text, parseOptions);
  if (!(value instanceof Map)) fail('expected a JSON object at the document root');
  return value;
}
