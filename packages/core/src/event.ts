import { toHex } from './bytes.js';
import { ValueTypeError } from './errors.js';
import { Finalizers } from './finalization.js';
import {
  cloneMetricValue,
  cloneSeries,
  type MetricKind,
  type MetricSeries,
  type MetricValue,
} from './metric.js';
import { deletePath, getPath, parsePathCached, setPath, type Path } from './path.js';
import { Timestamp } from './timestamp.js';
import { cloneValue, estimateSize, fromPlain, type Value, type ValueMap } from './value.js';

/** Information about an event that is not part of its payload. */
export interface EventMetadata {
  /** ID of the component that produced the event. */
  sourceId: string | undefined;
  /** Component type of the producing source, e.g. `http` or `file`. */
  sourceType: string | undefined;
  /** When Ferrule received the event. */
  receivedAt: Timestamp;
  /** Delivery tracking handles; see {@link Finalizers}. */
  finalizers: Finalizers;
}

export interface MetadataInit {
  sourceId?: string;
  sourceType?: string;
  receivedAt?: Timestamp;
  finalizers?: Finalizers;
}

export function createMetadata(init: MetadataInit = {}): EventMetadata {
  return {
    sourceId: init.sourceId,
    sourceType: init.sourceType,
    receivedAt: init.receivedAt ?? Timestamp.now(),
    finalizers: init.finalizers ?? new Finalizers(),
  };
}

/** Copies metadata for a cloned event. Finalizers are cloned, not shared. */
function cloneMetadata(metadata: EventMetadata): EventMetadata {
  return { ...metadata, finalizers: metadata.finalizers.clone() };
}

type PathLike = string | Path;

function toPath(path: PathLike): Path {
  return typeof path === 'string' ? parsePathCached(path) : path;
}

/** A structured log record. */
export class LogEvent {
  readonly kind = 'log' as const;
  fields: ValueMap;
  metadata: EventMetadata;

  constructor(fields: ValueMap = new Map(), metadata: EventMetadata = createMetadata()) {
    this.fields = fields;
    this.metadata = metadata;
  }

  /** Builds a log event from plain JavaScript data (see {@link fromPlain}). */
  static from(record: Record<string, unknown>, metadata?: MetadataInit): LogEvent {
    return new LogEvent(fromPlain(record) as ValueMap, createMetadata(metadata));
  }

  /** Builds a log event whose only field is `message`. */
  static fromMessage(message: string, metadata?: MetadataInit): LogEvent {
    return new LogEvent(new Map([['message', message]]), createMetadata(metadata));
  }

  get(path: PathLike): Value | undefined {
    return getPath(this.fields, toPath(path));
  }

  /** Sets a field. Setting the root path requires an object value and replaces all fields. */
  set(path: PathLike, value: Value): boolean {
    const p = toPath(path);
    if (p.length === 0) {
      if (!(value instanceof Map)) {
        throw new ValueTypeError('the root of a log event must be an object');
      }
      this.fields = value;
      return true;
    }
    return setPath(this.fields, p, value);
  }

  remove(path: PathLike): Value | undefined {
    return deletePath(this.fields, toPath(path));
  }

  has(path: PathLike): boolean {
    return this.get(path) !== undefined;
  }

  clone(): LogEvent {
    return new LogEvent(cloneValue(this.fields), cloneMetadata(this.metadata));
  }

  estimatedSize(): number {
    return estimateSize(this.fields);
  }
}

/** One data point of a metric series. */
export class MetricEvent {
  readonly kind = 'metric' as const;
  series: MetricSeries;
  metricKind: MetricKind;
  value: MetricValue;
  timestamp: Timestamp | undefined;
  /** Length of the collection interval this value covers, if known. */
  intervalMs: number | undefined;
  metadata: EventMetadata;

  constructor(init: {
    name: string;
    namespace?: string;
    tags?: Map<string, string> | Record<string, string>;
    kind: MetricKind;
    value: MetricValue;
    timestamp?: Timestamp;
    intervalMs?: number;
    metadata?: EventMetadata;
  }) {
    const tags = init.tags instanceof Map ? init.tags : new Map(Object.entries(init.tags ?? {}));
    this.series = { name: init.name, tags };
    if (init.namespace !== undefined) this.series.namespace = init.namespace;
    this.metricKind = init.kind;
    this.value = init.value;
    this.timestamp = init.timestamp;
    this.intervalMs = init.intervalMs;
    this.metadata = init.metadata ?? createMetadata();
  }

  get name(): string {
    return this.series.name;
  }

  get tags(): Map<string, string> {
    return this.series.tags;
  }

  clone(): MetricEvent {
    const copy = new MetricEvent({
      name: this.series.name,
      kind: this.metricKind,
      value: cloneMetricValue(this.value),
      metadata: cloneMetadata(this.metadata),
    });
    copy.series = cloneSeries(this.series);
    copy.timestamp = this.timestamp;
    copy.intervalMs = this.intervalMs;
    return copy;
  }

  estimatedSize(): number {
    let size = 64 + this.series.name.length + (this.series.namespace?.length ?? 0);
    for (const [k, v] of this.series.tags) size += 16 + k.length + v.length;
    switch (this.value.type) {
      case 'counter':
      case 'gauge':
        return size + 8;
      case 'set':
        for (const v of this.value.values) size += 8 + v.length;
        return size;
      case 'distribution':
        return size + this.value.samples.length * 16;
      case 'histogram':
        return size + 16 + this.value.buckets.length * 16;
      case 'summary':
        return size + 16 + this.value.quantiles.length * 16;
    }
  }
}

export type SpanKind = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface SpanStatus {
  code: 'unset' | 'ok' | 'error';
  message?: string;
}

/** A timestamped annotation on a span (OTLP "span event"). */
export interface SpanAnnotation {
  name: string;
  time: Timestamp;
  attributes: ValueMap;
}

export interface SpanLink {
  traceId: Uint8Array;
  spanId: Uint8Array;
  traceState?: string;
  attributes: ValueMap;
}

export interface InstrumentationScope {
  name: string;
  version?: string;
  attributes: ValueMap;
}

export interface SpanInit {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId?: Uint8Array;
  traceState?: string;
  name: string;
  spanKind?: SpanKind;
  startTime: Timestamp;
  endTime: Timestamp;
  status?: SpanStatus;
  attributes?: ValueMap;
  annotations?: SpanAnnotation[];
  links?: SpanLink[];
  resource?: ValueMap;
  scope?: InstrumentationScope;
  metadata?: EventMetadata;
}

/** One span of a distributed trace. */
export class SpanEvent {
  readonly kind = 'span' as const;
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId: Uint8Array | undefined;
  traceState: string | undefined;
  name: string;
  spanKind: SpanKind;
  startTime: Timestamp;
  endTime: Timestamp;
  status: SpanStatus;
  attributes: ValueMap;
  annotations: SpanAnnotation[];
  links: SpanLink[];
  resource: ValueMap;
  scope: InstrumentationScope | undefined;
  metadata: EventMetadata;

  constructor(init: SpanInit) {
    if (init.traceId.byteLength !== 16) throw new ValueTypeError('trace ID must be 16 bytes');
    if (init.spanId.byteLength !== 8) throw new ValueTypeError('span ID must be 8 bytes');
    if (init.parentSpanId !== undefined && init.parentSpanId.byteLength !== 8) {
      throw new ValueTypeError('parent span ID must be 8 bytes');
    }
    this.traceId = init.traceId;
    this.spanId = init.spanId;
    this.parentSpanId = init.parentSpanId;
    this.traceState = init.traceState;
    this.name = init.name;
    this.spanKind = init.spanKind ?? 'unspecified';
    this.startTime = init.startTime;
    this.endTime = init.endTime;
    this.status = init.status ?? { code: 'unset' };
    this.attributes = init.attributes ?? new Map<string, Value>();
    this.annotations = init.annotations ?? [];
    this.links = init.links ?? [];
    this.resource = init.resource ?? new Map<string, Value>();
    this.scope = init.scope;
    this.metadata = init.metadata ?? createMetadata();
  }

  get traceIdHex(): string {
    return toHex(this.traceId);
  }

  get spanIdHex(): string {
    return toHex(this.spanId);
  }

  get isRoot(): boolean {
    return this.parentSpanId === undefined;
  }

  /** Span duration in nanoseconds (never negative; clock skew is clamped to zero). */
  get durationNanos(): bigint {
    const d = this.endTime.since(this.startTime);
    return d < 0n ? 0n : d;
  }

  clone(): SpanEvent {
    const init: SpanInit = {
      traceId: this.traceId.slice(),
      spanId: this.spanId.slice(),
      name: this.name,
      spanKind: this.spanKind,
      startTime: this.startTime,
      endTime: this.endTime,
      status: { ...this.status },
      attributes: cloneValue(this.attributes),
      annotations: this.annotations.map((a) => ({ ...a, attributes: cloneValue(a.attributes) })),
      links: this.links.map((l) => ({
        ...l,
        traceId: l.traceId.slice(),
        spanId: l.spanId.slice(),
        attributes: cloneValue(l.attributes),
      })),
      resource: cloneValue(this.resource),
      metadata: cloneMetadata(this.metadata),
    };
    if (this.parentSpanId !== undefined) init.parentSpanId = this.parentSpanId.slice();
    if (this.traceState !== undefined) init.traceState = this.traceState;
    if (this.scope !== undefined) {
      init.scope = { ...this.scope, attributes: cloneValue(this.scope.attributes) };
    }
    return new SpanEvent(init);
  }

  estimatedSize(): number {
    let size = 96 + this.name.length + estimateSize(this.attributes) + estimateSize(this.resource);
    for (const a of this.annotations) size += 24 + a.name.length + estimateSize(a.attributes);
    for (const l of this.links) size += 40 + estimateSize(l.attributes);
    return size;
  }
}

export type Event = LogEvent | MetricEvent | SpanEvent;
export type EventKind = Event['kind'];

export function isLogEvent(event: Event): event is LogEvent {
  return event.kind === 'log';
}

export function isMetricEvent(event: Event): event is MetricEvent {
  return event.kind === 'metric';
}

export function isSpanEvent(event: Event): event is SpanEvent {
  return event.kind === 'span';
}
