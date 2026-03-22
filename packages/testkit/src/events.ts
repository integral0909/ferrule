import {
  createMetadata,
  fromHex,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  type Bucket,
  type MetadataInit,
  type MetricKind,
  type Quantile,
  type Sample,
  type SpanKind,
  type SpanStatus,
  type ValueMap,
} from '@ferrule/core';

/**
 * Event builders for tests: small, ergonomic constructors for every event kind, on top of
 * `@ferrule/core`'s own classes. Used by the component harnesses (`harness.ts`) and the pipeline
 * test runner (`testfile/`), and exported for direct use from a plugin author's own Vitest
 * suite (`import { log, counter } from '@ferrule/testkit'`).
 */

export interface MetricOptions {
  readonly namespace?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly timestamp?: Timestamp;
  readonly intervalMs?: number;
  readonly metadata?: MetadataInit;
}

/** A `LogEvent` from plain fields (see `@ferrule/core`'s `fromPlain` for the conversion rules). */
export function log(fields: Record<string, unknown> = {}, metadata?: MetadataInit): LogEvent {
  return metadata === undefined ? LogEvent.from(fields) : LogEvent.from(fields, metadata);
}

function metricInit(
  name: string,
  kind: MetricKind,
  value: MetricEvent['value'],
  options: MetricOptions,
): ConstructorParameters<typeof MetricEvent>[0] {
  const init: ConstructorParameters<typeof MetricEvent>[0] = {
    name,
    tags: options.tags ?? {},
    kind,
    value,
    metadata: createMetadata(options.metadata),
  };
  if (options.namespace !== undefined) init.namespace = options.namespace;
  if (options.timestamp !== undefined) init.timestamp = options.timestamp;
  if (options.intervalMs !== undefined) init.intervalMs = options.intervalMs;
  return init;
}

export function counter(name: string, value: number, options: MetricOptions = {}): MetricEvent {
  return new MetricEvent(metricInit(name, 'incremental', { type: 'counter', value }, options));
}

export function gauge(name: string, value: number, options: MetricOptions = {}): MetricEvent {
  return new MetricEvent(metricInit(name, 'absolute', { type: 'gauge', value }, options));
}

export function metricSet(
  name: string,
  values: readonly string[],
  options: MetricOptions = {},
): MetricEvent {
  return new MetricEvent(
    metricInit(name, 'incremental', { type: 'set', values: new Set(values) }, options),
  );
}

export function distribution(
  name: string,
  samples: readonly Sample[],
  options: MetricOptions & { statistic?: 'histogram' | 'summary' } = {},
): MetricEvent {
  const value: MetricEvent['value'] = {
    type: 'distribution',
    samples: samples.map((s) => ({ ...s })),
    statistic: options.statistic ?? 'histogram',
  };
  return new MetricEvent(metricInit(name, 'incremental', value, options));
}

export function histogram(
  name: string,
  buckets: readonly Bucket[],
  count: number,
  sum: number,
  options: MetricOptions = {},
): MetricEvent {
  const value: MetricEvent['value'] = {
    type: 'histogram',
    buckets: buckets.map((b) => ({ ...b })),
    count,
    sum,
  };
  return new MetricEvent(metricInit(name, 'incremental', value, options));
}

export function summary(
  name: string,
  quantiles: readonly Quantile[],
  count: number,
  sum: number,
  options: MetricOptions = {},
): MetricEvent {
  const value: MetricEvent['value'] = {
    type: 'summary',
    quantiles: quantiles.map((q) => ({ ...q })),
    count,
    sum,
  };
  return new MetricEvent(metricInit(name, 'incremental', value, options));
}

let spanSequence = 0;

/** Deterministic N-byte IDs, distinct per call, for spans that don't need a specific ID. */
function nextId(length: number): Uint8Array {
  spanSequence++;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (spanSequence * 2654435761 + i * 97) % 256;
  if (out.every((b) => b === 0)) out[length - 1] = 1;
  return out;
}

function toIdBytes(id: string | Uint8Array | undefined, length: number): Uint8Array {
  if (id === undefined) return nextId(length);
  return typeof id === 'string' ? fromHex(id) : id;
}

export interface SpanOptions {
  readonly traceId?: string | Uint8Array;
  readonly spanId?: string | Uint8Array;
  readonly parentSpanId?: string | Uint8Array;
  readonly spanKind?: SpanKind;
  /** Nanoseconds since the epoch, or a `Timestamp`. Default: 0. */
  readonly startTime?: bigint | Timestamp;
  /** Nanoseconds since the epoch, or a `Timestamp`. Default: `startTime + durationNanos`. */
  readonly endTime?: bigint | Timestamp;
  /** Used only when `endTime` is omitted. Default 1ms. */
  readonly durationNanos?: bigint;
  readonly status?: SpanStatus;
  readonly attributes?: Record<string, unknown>;
  readonly resource?: Record<string, unknown>;
  readonly metadata?: MetadataInit;
}

function toTimestamp(value: bigint | Timestamp): Timestamp {
  return value instanceof Timestamp ? value : Timestamp.fromNanos(value);
}

/** A `SpanEvent` with sensible defaults: a deterministic 16/8-byte trace/span ID if omitted. */
export function span(name: string, options: SpanOptions = {}): SpanEvent {
  const traceId = toIdBytes(options.traceId, 16);
  const spanId = toIdBytes(options.spanId, 8);
  const start = toTimestamp(options.startTime ?? 0n);
  const end =
    options.endTime !== undefined
      ? toTimestamp(options.endTime)
      : Timestamp.fromNanos(start.nanos + (options.durationNanos ?? 1_000_000n));

  const init: ConstructorParameters<typeof SpanEvent>[0] = {
    traceId,
    spanId,
    name,
    startTime: start,
    endTime: end,
    attributes: log(options.attributes ?? {}).fields,
    resource: log(options.resource ?? {}).fields,
    metadata: createMetadata(options.metadata),
  };
  if (options.parentSpanId !== undefined) init.parentSpanId = toIdBytes(options.parentSpanId, 8);
  if (options.spanKind !== undefined) init.spanKind = options.spanKind;
  if (options.status !== undefined) init.status = options.status;
  return new SpanEvent(init);
}

export type { ValueMap };
