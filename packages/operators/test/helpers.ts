import {
  BatchNotifier,
  createMetadata,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  type DeliveryStatus,
  type Event,
  type MetricKind,
  type MetricValue,
} from '@ferrule/core';
import {
  createTestTransformContext,
  type TestTransformHarness,
  type Transform,
  type TransformDefinition,
  type TransformOutput,
} from '@ferrule/runtime';

export interface BuiltTransform {
  /**
   * Every built-in operator in this package implements the synchronous `process()`, not
   * `processAsync()`; narrowed here (and checked at runtime below) so call sites can keep
   * calling `transform.process(...)` directly without an optional-chain on every call.
   */
  readonly transform: Transform & { process: (events: Event[], out: TransformOutput) => void };
  readonly harness: TestTransformHarness;
}

/**
 * Builds and starts a transform from a definition and raw (unvalidated) options, wired to a
 * fresh `createTestTransformContext()` harness. Mirrors how the runtime itself builds a
 * transform (`definition.build(options, buildCtx)` then `transform.start?.(ctx)`), so tests
 * exercise the same contract real pipelines do.
 */
export async function buildTransform<Options>(
  definition: TransformDefinition<Options>,
  rawOptions: unknown,
  harnessOptions: Parameters<typeof createTestTransformContext>[0] = {},
): Promise<BuiltTransform> {
  const options = definition.options.parse(rawOptions);
  const harness = createTestTransformContext(harnessOptions);
  const transform = await definition.build(options, {
    id: harness.ctx.id,
    logger: harness.ctx.logger,
    dataDir: harness.ctx.dataDir,
    inputs: [],
  });
  transform.start?.(harness.ctx);
  if (transform.process === undefined) {
    throw new Error(
      `buildTransform: ${definition.type} implements processAsync(), not process(); ` +
        'this helper only supports synchronous built-in operators.',
    );
  }
  return { transform: transform as BuiltTransform['transform'], harness };
}

/** A `BatchNotifier` with one finalizer already attached to each of `events`, sealed. */
export function sealedBatch(events: readonly Event[]): BatchNotifier {
  const batch = new BatchNotifier();
  for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch;
}

export function logEvent(fields: Record<string, unknown>): LogEvent {
  return LogEvent.from(fields);
}

export function metricEvent(init: {
  name: string;
  namespace?: string;
  tags?: Record<string, string>;
  kind: MetricKind;
  value: MetricValue;
  timestamp?: Timestamp;
}): MetricEvent {
  const ctor: ConstructorParameters<typeof MetricEvent>[0] = {
    name: init.name,
    tags: init.tags ?? {},
    kind: init.kind,
    value: init.value,
    metadata: createMetadata(),
  };
  if (init.namespace !== undefined) ctor.namespace = init.namespace;
  if (init.timestamp !== undefined) ctor.timestamp = init.timestamp;
  return new MetricEvent(ctor);
}

export function counterMetric(
  name: string,
  value: number,
  tags: Record<string, string> = {},
): MetricEvent {
  return metricEvent({ name, tags, kind: 'incremental', value: { type: 'counter', value } });
}

export function gaugeMetric(
  name: string,
  value: number,
  tags: Record<string, string> = {},
): MetricEvent {
  return metricEvent({ name, tags, kind: 'absolute', value: { type: 'gauge', value } });
}

let spanCounter = 0;

/** A span with a deterministic 16-byte trace ID and 8-byte span ID, for reproducible tests. */
export function spanEvent(init: {
  traceId?: number;
  spanId?: number;
  parentSpanId?: number;
  name?: string;
  startNanos?: bigint;
  durationNanos?: bigint;
  status?: 'unset' | 'ok' | 'error';
  attributes?: Record<string, unknown>;
}): SpanEvent {
  spanCounter++;
  const traceId = idBytes(16, init.traceId ?? 1);
  const spanId = idBytes(8, init.spanId ?? spanCounter);
  const start = init.startNanos ?? 0n;
  const duration = init.durationNanos ?? 1_000_000n;
  const ctor: ConstructorParameters<typeof SpanEvent>[0] = {
    traceId,
    spanId,
    name: init.name ?? 'op',
    startTime: Timestamp.fromNanos(start),
    endTime: Timestamp.fromNanos(start + duration),
    status: { code: init.status ?? 'unset' },
    attributes: LogEvent.from(init.attributes ?? {}).fields,
  };
  if (init.parentSpanId !== undefined) ctor.parentSpanId = idBytes(8, init.parentSpanId);
  return new SpanEvent(ctor);
}

function idBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed * 2654435761 + i * 97) % 256;
  // Ensure the ID is never all-zero, which core rejects for some checks elsewhere.
  if (out.every((b) => b === 0)) out[length - 1] = 1;
  return out;
}

/** Awaits a `BatchNotifier`'s completion, returning the resulting status. */
export async function completionOf(batch: BatchNotifier): Promise<DeliveryStatus> {
  return batch.completion;
}
