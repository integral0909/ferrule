import type { Event, EventKind, MetricEvent, Timestamp } from '@ferrule/core';
import type { Schema } from '@ferrule/schema';

/**
 * The component contract: the interfaces every source, transform, and sink implements, and
 * the services the runtime provides to them. Built-in components and third-party plugins use
 * exactly the same contract.
 */

export type ComponentKind = 'source' | 'transform' | 'sink';

export type TransformContext = ComponentContext;

/** The name of the default output port. Components may declare additional named ports. */
export const DEFAULT_PORT = '_default';

/**
 * The conventional port for events a transform could not process (for example a script that
 * `abort`s). Components that declare it let users route failures instead of dropping them.
 */
export const ERROR_PORT = 'errors';

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logger. Field values must not contain secrets; the runtime does not scrub them. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger that adds `fields` to every record. */
  child(fields: Record<string, unknown>): Logger;
}

/** Time source. Injected so that tests can control time deterministically. */
export interface Clock {
  /** Current wall-clock time. */
  now(): Timestamp;
  /** Monotonic milliseconds, for measuring intervals; unrelated to wall-clock time. */
  monotonic(): number;
  /**
   * Resolves after `ms` milliseconds. If `signal` aborts first, rejects with the signal's
   * reason.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type MetricTags = Readonly<Record<string, string>>;

export interface Counter {
  increment(by?: number): void;
}

export interface Gauge {
  set(value: number): void;
  add(delta: number): void;
}

export interface Histogram {
  record(value: number): void;
}

/**
 * Records Ferrule's own metrics. The runtime tags every metric with the component's ID, kind,
 * and type; components add only their own tags. Instruments are cached by name and tags, so
 * calling `counter(...)` repeatedly is cheap, but hot paths should still hold on to them.
 */
export interface MetricsRecorder {
  counter(name: string, tags?: MetricTags): Counter;
  gauge(name: string, tags?: MetricTags): Gauge;
  histogram(name: string, tags?: MetricTags): Histogram;
  /**
   * Every instrument recorded in the whole pipeline, as metric events. Provided by the runtime's
   * recorders; used by the `internal_metrics` source to publish Ferrule's own telemetry.
   */
  snapshot?(): MetricEvent[];
}

/**
 * Standard internal metric names. The runtime records the event and byte counts at component
 * boundaries itself; components record the others where they apply.
 */
export const Metrics = {
  receivedEvents: 'component_received_events_total',
  receivedBytes: 'component_received_bytes_total',
  sentEvents: 'component_sent_events_total',
  sentBytes: 'component_sent_bytes_total',
  errors: 'component_errors_total',
  discardedEvents: 'component_discarded_events_total',
  requestDurationSeconds: 'component_request_duration_seconds',
  bufferEvents: 'buffer_events',
  bufferBytes: 'buffer_bytes',
} as const;

// ---------------------------------------------------------------------------------------------
// Context shared by all components
// ---------------------------------------------------------------------------------------------

export interface ComponentContext {
  /** The component's ID from configuration. */
  readonly id: string;
  /** The component type, e.g. `http`. */
  readonly type: string;
  readonly kind: ComponentKind;
  readonly logger: Logger;
  readonly metrics: MetricsRecorder;
  readonly clock: Clock;
  /**
   * Aborted when the component must stop: on shutdown, on reload when the component is
   * removed or replaced, or when the pipeline fails.
   */
  readonly signal: AbortSignal;
  /**
   * A directory reserved for this component's durable state (checkpoints, offsets), created on
   * demand by the runtime. `undefined` when the pipeline has no data directory configured;
   * components that need one must fail at build time with a clear message.
   */
  readonly dataDir: string | undefined;
  /** Whether end-to-end acknowledgements are enabled for this component. */
  readonly acknowledgements: boolean;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export interface SourceOutput {
  /**
   * Sends events downstream on `port` (default {@link DEFAULT_PORT}). The promise resolves once
   * the events are accepted by the output channel, and stays pending while the channel is full:
   * this is how backpressure reaches sources. Rejects with {@link ShutdownError} if the pipeline
   * stops while waiting.
   */
  send(events: Event | readonly Event[], port?: string): Promise<void>;
}

export interface SourceContext extends ComponentContext {
  readonly output: SourceOutput;
}

export interface Source {
  /**
   * Produces events until `ctx.signal` aborts, then stops accepting new input, finishes
   * in-flight work, and resolves. Rejecting marks the component as failed.
   */
  run(ctx: SourceContext): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------------------------

export interface TransformOutput {
  /** Emits an event on `port` (default {@link DEFAULT_PORT}). Never blocks. */
  push(event: Event, port?: string): void;
}

/**
 * A transform processes batches one at a time, in arrival order, with the runtime applying
 * backpressure between batches: it does not read the next batch (or run a due {@link tick}, or
 * call {@link flush}) until the current one's `process`/`processAsync` call has resolved. A
 * transform implements **exactly one** of `process` (synchronous) or `processAsync`
 * (asynchronous) — implementing both, or neither, fails the component at build time with a
 * {@link "./errors.js".TransformContractError}.
 */
export interface Transform {
  /** Called once before the first batch, with the services the transform may use. */
  start?(ctx: TransformContext): void;
  /**
   * Processes one batch synchronously. Implement this, not {@link processAsync}, unless the
   * transform genuinely needs to await something per batch: synchronous processing has no
   * per-batch Promise/microtask overhead and keeps ordering trivially deterministic.
   *
   * Must not throw for bad input data: route the event to {@link ERROR_PORT} (if declared) or
   * drop it and count it under `discardedEvents`. A thrown exception is treated as a bug and
   * fails the component.
   *
   * The transform owns the events it receives: it may mutate them and must either push them,
   * or finish their finalizers (`delivered` when intentionally dropped, `rejected` when
   * discarded because of an error) so acknowledgements never hang.
   */
  process?(events: Event[], out: TransformOutput): void;
  /**
   * Processes one batch asynchronously — for a transform that must await something per batch
   * (an external lookup, handing the batch to a `worker_threads` pool, …) without blocking the
   * event loop while it does. The runtime awaits the returned promise before handing the
   * transform its next batch, before running a due {@link tick}, and before {@link flush}, so a
   * slow or failing call delays and fails exactly as a slow or throwing `process` call would.
   *
   * Ownership, mutation, and finalizer rules are identical to {@link process}: route bad data to
   * {@link ERROR_PORT} or finish it, and either push every event onward or finish its finalizers
   * before the returned promise resolves. A thrown exception (or a rejected promise) fails the
   * component, exactly like `process` throwing.
   */
  processAsync?(events: Event[], out: TransformOutput): Promise<void>;
  /** If set, the runtime calls {@link tick} at this interval (for windows and timeouts). */
  readonly tickIntervalMs?: number;
  tick?(now: Timestamp, out: TransformOutput): void;
  /** Called once when the transform stops, after its inputs are drained, to flush state. */
  flush?(out: TransformOutput): void;
}

// ---------------------------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------------------------

/**
 * The stream of event batches delivered to a sink. It ends after shutdown begins and all
 * upstream events have been delivered to the sink.
 */
export type SinkInput = AsyncIterable<Event[]>;

export interface SinkContext extends ComponentContext {
  readonly input: SinkInput;
}

export interface Sink {
  /**
   * Consumes `ctx.input` until it ends and resolves once everything it accepted has been
   * written or has definitively failed. Every event must have its finalizers finished with
   * the delivery outcome (`delivered`, `errored` for retryable failures that exhausted
   * retries, `rejected` for permanent failures).
   */
  run(ctx: SinkContext): Promise<void>;
  /** Optional connectivity check, run at startup unless health checks are disabled. */
  healthcheck?(ctx: ComponentContext): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Definitions and registry
// ---------------------------------------------------------------------------------------------

export interface OutputPort {
  name: string;
  description: string;
}

/** Information available while building a component from validated options. */
export interface BuildContext {
  readonly id: string;
  readonly logger: Logger;
  readonly dataDir: string | undefined;
  /** IDs of the components feeding this one (empty for sources). */
  readonly inputs: readonly string[];
}

export interface ConfigExample {
  title: string;
  /** The component's configuration as it would appear in YAML (without the `type` key). */
  config: Record<string, unknown>;
}

interface DefinitionBase<Options> {
  /** The `type` users write in configuration, e.g. `http`, `script`, `clickhouse`. */
  readonly type: string;
  /** One line, shown in `ferrule list` and generated docs. */
  readonly description: string;
  readonly options: Schema<Options>;
  readonly examples?: readonly ConfigExample[];
}

export interface SourceDefinition<Options = unknown> extends DefinitionBase<Options> {
  readonly kind: 'source';
  /** Event kinds this source can produce for the given options. */
  produces(options: Options): readonly EventKind[];
  /** Additional named output ports. */
  outputs?(options: Options): readonly OutputPort[];
  build(options: Options, ctx: BuildContext): Source | Promise<Source>;
}

export interface TransformDefinition<Options = unknown> extends DefinitionBase<Options> {
  readonly kind: 'transform';
  readonly accepts: readonly EventKind[];
  /** Event kinds emitted for the given input kinds. Defaults to the input kinds. */
  produces?(options: Options, inputKinds: readonly EventKind[]): readonly EventKind[];
  outputs?(options: Options): readonly OutputPort[];
  /**
   * Build errors (for example a script that fails to compile) must be thrown as
   * `FerruleError`s; they are reported during validation, before anything starts.
   */
  build(options: Options, ctx: BuildContext): Transform | Promise<Transform>;
}

export interface SinkDefinition<Options = unknown> extends DefinitionBase<Options> {
  readonly kind: 'sink';
  readonly accepts: readonly EventKind[];
  build(options: Options, ctx: BuildContext): Sink | Promise<Sink>;
}

export type ComponentDefinition = SourceDefinition | TransformDefinition | SinkDefinition;

/** Identity helpers that give component authors full type inference on `options`. */
export function defineSource<Options>(
  definition: SourceDefinition<Options>,
): SourceDefinition<Options> {
  return definition;
}

export function defineTransform<Options>(
  definition: TransformDefinition<Options>,
): TransformDefinition<Options> {
  return definition;
}

export function defineSink<Options>(definition: SinkDefinition<Options>): SinkDefinition<Options> {
  return definition;
}
