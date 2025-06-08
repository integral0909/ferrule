/**
 * Testing helpers for component authors: a deterministic clock, a capturing logger, per-kind
 * test contexts (so a source/transform/sink can be unit-tested without a running pipeline), and
 * a collecting sink / scripted source pair for end-to-end pipeline tests. Also re-exported from
 * the package's main entry point.
 */
import { BatchNotifier, type DeliveryStatus, type Event, type EventKind } from '@ferrule/core';
import { s } from '@ferrule/schema';
import {
  DEFAULT_PORT,
  defineSink,
  defineSource,
  type ComponentContext,
  type Logger,
  type LogLevel,
  type SinkContext,
  type SinkDefinition,
  type SourceContext,
  type SourceDefinition,
  type SourceOutput,
  type TransformContext,
  type TransformOutput,
} from './component.js';
import { ManualClock } from './clock.js';
import { MetricsRegistry } from './metrics.js';
import { EventChannel } from './channel.js';

export { ManualClock } from './clock.js';

function isEventArray(events: Event | readonly Event[]): events is readonly Event[] {
  return Array.isArray(events);
}

// -------------------------------------------------------------------------------------------
// Capturing logger
// -------------------------------------------------------------------------------------------

export interface CapturedLogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

class CapturingLoggerImpl implements Logger {
  constructor(
    private readonly records: CapturedLogRecord[],
    private readonly fields: Record<string, unknown> = {},
  ) {}

  private push(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): void {
    this.records.push({
      level,
      message,
      fields: fields === undefined ? this.fields : { ...this.fields, ...fields },
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.push('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.push('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.push('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.push('error', message, fields);
  }

  child(fields: Record<string, unknown>): Logger {
    return new CapturingLoggerImpl(this.records, { ...this.fields, ...fields });
  }
}

/** A `Logger` that records every call instead of writing anywhere, for assertions in tests. */
export function createCapturingLogger(): { logger: Logger; records: CapturedLogRecord[] } {
  const records: CapturedLogRecord[] = [];
  return { logger: new CapturingLoggerImpl(records), records };
}

// -------------------------------------------------------------------------------------------
// Per-kind test contexts
// -------------------------------------------------------------------------------------------

export interface TestContextOptions {
  readonly id?: string;
  readonly type?: string;
  readonly dataDir?: string;
  readonly acknowledgements?: boolean;
}

function baseTestContext(
  kind: ComponentContext['kind'],
  options: TestContextOptions,
): {
  ctx: ComponentContext;
  clock: ManualClock;
  metrics: MetricsRegistry;
  logger: Logger;
  logs: CapturedLogRecord[];
  abortController: AbortController;
} {
  const clock = new ManualClock();
  const metrics = new MetricsRegistry({ clock });
  const { logger, records } = createCapturingLogger();
  const abortController = new AbortController();
  return {
    ctx: {
      id: options.id ?? `test-${kind}`,
      type: options.type ?? 'test',
      kind,
      logger,
      metrics,
      clock,
      signal: abortController.signal,
      dataDir: options.dataDir,
      acknowledgements: options.acknowledgements ?? true,
    },
    clock,
    metrics,
    logger,
    logs: records,
    abortController,
  };
}

export interface SentBatch {
  readonly port: string;
  readonly events: Event[];
}

export interface TestSourceHarness {
  readonly ctx: SourceContext;
  readonly clock: ManualClock;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly logs: CapturedLogRecord[];
  /** Every call made to `ctx.output.send`, in order. */
  readonly sent: SentBatch[];
  abort(reason?: unknown): void;
}

/** Builds a `SourceContext` backed by a `ManualClock`, for unit-testing a `Source` in isolation. */
export function createTestSourceContext(options: TestContextOptions = {}): TestSourceHarness {
  const base = baseTestContext('source', options);
  const sent: SentBatch[] = [];
  const output: SourceOutput = {
    send: (events, port = DEFAULT_PORT) => {
      const list = isEventArray(events) ? [...events] : [events];
      sent.push({ port, events: list });
      return Promise.resolve();
    },
  };
  return {
    ctx: { ...base.ctx, output },
    clock: base.clock,
    metrics: base.metrics,
    logger: base.logger,
    logs: base.logs,
    sent,
    abort: (reason?: unknown) => base.abortController.abort(reason),
  };
}

export interface PushedEvent {
  readonly port: string;
  readonly event: Event;
}

export interface TestTransformHarness {
  readonly ctx: TransformContext;
  readonly out: TransformOutput;
  /** Every call made to `out.push`, in order. */
  readonly pushed: PushedEvent[];
  readonly clock: ManualClock;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly logs: CapturedLogRecord[];
  abort(reason?: unknown): void;
}

/** Builds a `TransformContext` and a recording `TransformOutput`, for unit-testing a `Transform`. */
export function createTestTransformContext(options: TestContextOptions = {}): TestTransformHarness {
  const base = baseTestContext('transform', options);
  const pushed: PushedEvent[] = [];
  const out: TransformOutput = {
    push: (event, port = DEFAULT_PORT) => {
      pushed.push({ port, event });
    },
  };
  return {
    ctx: base.ctx,
    out,
    pushed,
    clock: base.clock,
    metrics: base.metrics,
    logger: base.logger,
    logs: base.logs,
    abort: (reason?: unknown) => base.abortController.abort(reason),
  };
}

export interface TestSinkHarness {
  readonly ctx: SinkContext;
  readonly clock: ManualClock;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly logs: CapturedLogRecord[];
  /** Feeds a batch to `ctx.input`, awaiting the sink's own backpressure. */
  feed(events: Event | readonly Event[]): Promise<void>;
  /** Ends `ctx.input` after any buffered batches are consumed. */
  close(): void;
  abort(reason?: unknown): void;
}

/** Builds a `SinkContext` whose input is fed manually, for unit-testing a `Sink`. */
export function createTestSinkContext(options: TestContextOptions = {}): TestSinkHarness {
  const base = baseTestContext('sink', options);
  const channel = new EventChannel(`${base.ctx.id}.input`, {}, 'block');
  return {
    ctx: { ...base.ctx, input: channel },
    clock: base.clock,
    metrics: base.metrics,
    logger: base.logger,
    logs: base.logs,
    feed: (events) => channel.send(isEventArray(events) ? events : [events]).then(() => undefined),
    close: () => channel.close(),
    abort: (reason?: unknown) => base.abortController.abort(reason),
  };
}

// -------------------------------------------------------------------------------------------
// Collecting sink & scripted source, for pipeline-level tests
// -------------------------------------------------------------------------------------------

/** Everything a `createCollectingSinkDefinition` sink has received, in arrival order. */
export interface Collector {
  readonly batches: Event[][];
  readonly events: Event[];
}

export interface CreateCollectingSinkOptions {
  readonly type?: string;
  readonly accepts?: readonly EventKind[];
  /**
   * Status each received event's finalizers are finished with. Default: `delivered`. Return
   * `undefined` to leave the event unfinished, so the test controls acknowledgement timing.
   */
  readonly finish?: (event: Event) => DeliveryStatus | undefined;
}

/** A `SinkDefinition` that records every event it receives, for asserting on pipeline output. */
export function createCollectingSinkDefinition(options: CreateCollectingSinkOptions = {}): {
  definition: SinkDefinition<Record<string, never>>;
  collector: Collector;
} {
  const batches: Event[][] = [];
  const events: Event[] = [];
  const finish = options.finish ?? ((): DeliveryStatus => 'delivered');

  const definition = defineSink<Record<string, never>>({
    kind: 'sink',
    type: options.type ?? 'test_collect',
    description: 'Collects every event it receives. For tests only.',
    options: s.object({}),
    accepts: options.accepts ?? ['log', 'metric', 'span'],
    build: () => ({
      run: async (ctx) => {
        for await (const batch of ctx.input) {
          batches.push(batch);
          for (const event of batch) {
            events.push(event);
            const status = finish(event);
            if (status !== undefined) event.metadata.finalizers.finish(status);
          }
        }
      },
    }),
  });
  return { definition, collector: { batches, events } };
}

export interface ScriptStep {
  readonly events: readonly Event[];
  /** Port to send on. Default the component's default port. */
  readonly port?: string;
  /** Delay, via `ctx.clock`, before sending this step. Default 0 (send immediately). */
  readonly delayMs?: number;
}

export interface ScriptedSourceHandle {
  /** The delivery status of each step's batch, in the order the steps were scripted. */
  readonly completions: Promise<DeliveryStatus>[];
  /** Resolves once every scripted step has been sent (not necessarily acknowledged yet). */
  readonly allSent: Promise<void>;
}

export interface CreateScriptedSourceOptions {
  readonly type?: string;
  readonly produces?: readonly EventKind[];
}

/**
 * A `SourceDefinition` that sends a pre-scripted sequence of event batches and then idles until
 * aborted (as a well-behaved source does). Each step gets its own `BatchNotifier`, so tests can
 * assert on the acknowledgement status the source would observe.
 */
export function createScriptedSourceDefinition(
  steps: readonly ScriptStep[],
  options: CreateScriptedSourceOptions = {},
): { definition: SourceDefinition<Record<string, never>>; handle: ScriptedSourceHandle } {
  const completions: Promise<DeliveryStatus>[] = [];
  let resolveAllSent!: () => void;
  const allSent = new Promise<void>((resolve) => {
    resolveAllSent = resolve;
  });

  const definition = defineSource<Record<string, never>>({
    kind: 'source',
    type: options.type ?? 'test_script',
    description: 'Emits a scripted sequence of events, then idles until stopped. For tests only.',
    options: s.object({}),
    produces: () => options.produces ?? ['log'],
    build: () => ({
      run: async (ctx) => {
        for (const step of steps) {
          if (ctx.signal.aborted) {
            resolveAllSent();
            return;
          }
          if (step.delayMs !== undefined && step.delayMs > 0) {
            try {
              await ctx.clock.sleep(step.delayMs, ctx.signal);
            } catch {
              resolveAllSent();
              return;
            }
          }
          const batch = new BatchNotifier();
          for (const event of step.events) event.metadata.finalizers.add(batch.createFinalizer());
          completions.push(batch.completion);
          await ctx.output.send(step.events, step.port);
          batch.seal();
        }
        resolveAllSent();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    }),
  });
  return { definition, handle: { completions, allSent } };
}
