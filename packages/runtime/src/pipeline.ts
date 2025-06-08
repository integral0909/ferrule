import { FerruleError, type Event } from '@ferrule/core';
import {
  DEFAULT_PORT,
  Metrics,
  type ComponentContext,
  type ComponentKind,
  type Clock,
  type Logger,
  type Sink,
  type SinkContext,
  type SinkInput,
  type Source,
  type SourceContext,
  type SourceOutput,
  type Transform,
  type TransformOutput,
} from './component.js';
import { ShutdownError, type ComponentRegistry } from './registry.js';
import { EventChannel, distributeFanOut, type ChannelCapacity, type WhenFull } from './channel.js';
import { type EventBuffer, type EventBufferFactory } from './buffer.js';
import { MetricsRegistry } from './metrics.js';
import { SystemClock } from './clock.js';
import { createNullLogger } from './logger.js';
import { TapHub, type TapOptions, type TapSubscription, type TapTarget } from './tap.js';
import {
  ComponentFailureError,
  InvalidPortError,
  TopologyValidationError,
  describeError,
  type TopologyIssue,
} from './errors.js';
import {
  buildTopology,
  formatInputRef,
  type BuiltComponent,
  type Topology,
  type TopologySpec,
} from './topology.js';
import { deepEqual, timedOut, AsyncMutex } from './util.js';

// -------------------------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------------------------

export type ComponentState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface ComponentHealth {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly type: string;
  readonly state: ComponentState;
  readonly error?: string;
}

export type PipelineOverallState =
  'starting' | 'running' | 'degraded' | 'stopping' | 'stopped' | 'failed';

export interface PipelineHealth {
  readonly overall: PipelineOverallState;
  readonly components: readonly ComponentHealth[];
}

export interface TopologySnapshotComponent {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly type: string;
  readonly inputs: readonly string[];
}

/** A read-only view of the running graph, suitable for an admin API. */
export interface TopologySnapshot {
  readonly components: readonly TopologySnapshotComponent[];
}

export interface PipelineOptions {
  readonly registry: ComponentRegistry;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly metrics?: MetricsRegistry;
  /** Builds a disk-backed {@link EventBuffer} for sinks configured with `buffer: { kind: disk }`. */
  readonly bufferFactory?: EventBufferFactory;
}

export type ReloadResult =
  | {
      readonly ok: true;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
      readonly unchanged: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly TopologyIssue[] };

// -------------------------------------------------------------------------------------------
// Internal wiring
// -------------------------------------------------------------------------------------------

interface RunningComponent {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly type: string;
  built: BuiltComponent;
  state: ComponentState;
  error: string | undefined;
  readonly abort: AbortController;
  readonly inbox: EventChannel | undefined;
  buffer: EventBuffer | undefined;
  pumpTask: Promise<void> | undefined;
  readonly router: OutputRouter | undefined;
  runPromise: Promise<void>;
  readonly mutex: AsyncMutex;
  /** Number of distinct upstream producers that have not yet finished feeding this component. */
  pendingProducers: number;
  /** Snapshot, fixed when this component was wired, of who consumes its output. */
  consumers: RunningComponent[];
}

/** Routes one producer's port pushes to the inbox channels of everything currently wired to it. */
class OutputRouter {
  private edges = new Map<string, EventChannel[]>();

  constructor(
    private readonly componentId: string,
    private readonly declaredPorts: readonly string[],
  ) {}

  reset(): void {
    this.edges = new Map();
  }

  connect(port: string, channel: EventChannel): void {
    const list = this.edges.get(port) ?? [];
    list.push(channel);
    this.edges.set(port, list);
  }

  targets(port: string): EventChannel[] {
    if (!this.declaredPorts.includes(port)) {
      throw new InvalidPortError(this.componentId, port, this.declaredPorts);
    }
    return this.edges.get(port) ?? [];
  }
}

function sumBytes(events: readonly Event[]): number {
  let bytes = 0;
  for (const e of events) bytes += e.estimatedSize();
  return bytes;
}

function isEventArray(events: Event | readonly Event[]): events is readonly Event[] {
  return Array.isArray(events);
}

function normalizeEvents(events: Event | readonly Event[]): Event[] {
  return isEventArray(events) ? events.slice() : [events];
}

// -------------------------------------------------------------------------------------------
// Pipeline
// -------------------------------------------------------------------------------------------

/**
 * A running pipeline: bounded channels wiring together built source, transform, and sink
 * instances, with lifecycle management, graceful shutdown, hot reload, and a tap API. Build one
 * with {@link Pipeline.create}.
 */
export class Pipeline {
  private topology: Topology;
  private readonly tapHub: TapHub;
  private readonly components = new Map<string, RunningComponent>();
  private readonly retiring = new Set<RunningComponent>();
  private started = false;
  private stopping = false;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  private constructor(
    topology: Topology,
    private readonly registry: ComponentRegistry,
    private readonly logger: Logger,
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
    private readonly bufferFactory: EventBufferFactory | undefined,
  ) {
    this.topology = topology;
    this.tapHub = new TapHub(clock);
  }

  /** Validates and builds `spec` and returns a pipeline ready to {@link start}. */
  static async create(spec: TopologySpec, options: PipelineOptions): Promise<Pipeline> {
    const logger = options.logger ?? createNullLogger();
    const clock = options.clock ?? new SystemClock();
    const metrics = options.metrics ?? new MetricsRegistry({ clock });
    const result = await buildTopology(spec, options.registry, { logger });
    if (!result.ok) throw new TopologyValidationError([...result.errors, ...result.warnings]);
    for (const w of result.warnings) {
      logger.warn(w.message, { code: w.code, componentId: w.componentId });
    }
    return new Pipeline(
      result.topology,
      options.registry,
      logger,
      clock,
      metrics,
      options.bufferFactory,
    );
  }

  /** Runs healthchecks, then starts every component (sinks, then transforms, then sources). */
  async start(): Promise<void> {
    if (this.started) return;
    await this.instantiateComponents(this.topology.order);
    this.rebuildRouting();
    await this.startComponents(this.topology.order);
    this.started = true;
  }

  /**
   * Gracefully stops the pipeline: aborts sources, lets transforms drain in dependency order and
   * flush, lets sinks finish. If `settings.shutdownDeadlineMs` elapses first, remaining buffered
   * events are finalized as `errored` and every component is force-aborted. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  /**
   * Validates and builds `spec` completely before touching anything (on error, the running
   * pipeline is untouched). Diffs the new topology against the current one by component ID,
   * type, options, and inputs: unchanged components (including their buffers) keep running,
   * added components start, removed components drain and stop, and changed components are
   * replaced (the old instance drains in the background while the new one takes over routing).
   */
  async reload(spec: TopologySpec): Promise<ReloadResult> {
    const result = await buildTopology(spec, this.registry, { logger: this.logger });
    if (!result.ok) return { ok: false, errors: result.errors };
    for (const w of result.warnings) {
      this.logger.warn(w.message, { code: w.code, componentId: w.componentId });
    }

    const oldIds = new Set(this.topology.components.keys());
    const newIds = new Set(result.topology.components.keys());
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const id of newIds) {
      if (!oldIds.has(id)) {
        added.push(id);
        continue;
      }
      const before = this.topology.components.get(id)!;
      const after = result.topology.components.get(id)!;
      const same =
        before.type === after.type &&
        deepEqual(before.options, after.options) &&
        deepEqual(before.inputs, after.inputs);
      (same ? unchanged : changed).push(id);
    }
    for (const id of oldIds) if (!newIds.has(id)) removed.push(id);

    const mergedComponents = new Map(result.topology.components);
    for (const id of unchanged) mergedComponents.set(id, this.topology.components.get(id)!);

    const retiring = [...changed, ...removed].map((id) => this.components.get(id)!);
    for (const id of [...changed, ...removed]) this.components.delete(id);

    this.topology = {
      spec,
      components: mergedComponents,
      order: result.topology.order,
      settings: result.topology.settings,
    };

    await this.instantiateComponents([...added, ...changed]);
    this.rebuildRouting();
    await this.startComponents([...added, ...changed]);

    for (const rc of retiring) this.retiring.add(rc);
    void Promise.all(
      retiring.map((rc) =>
        this.drainAndStop(rc, this.topology.settings.shutdownDeadlineMs).finally(() =>
          this.retiring.delete(rc),
        ),
      ),
    );

    return { ok: true, added, removed, changed, unchanged };
  }

  /** Per-component state and, for the pipeline as a whole, the worst state present. */
  health(): PipelineHealth {
    const components: ComponentHealth[] = [];
    let anyFailed = false;
    let anyStarting = false;
    for (const rc of [...this.components.values(), ...this.retiring]) {
      components.push({
        id: rc.id,
        kind: rc.kind,
        type: rc.type,
        state: rc.state,
        ...(rc.error !== undefined ? { error: rc.error } : {}),
      });
      if (rc.state === 'failed') anyFailed = true;
      if (rc.state === 'starting') anyStarting = true;
    }
    let overall: PipelineOverallState;
    if (this.stopped) overall = 'stopped';
    else if (this.stopping) overall = 'stopping';
    else if (anyFailed) {
      overall = this.topology.settings.continueOnComponentFailure ? 'degraded' : 'failed';
    } else if (!this.started || anyStarting) overall = 'starting';
    else overall = 'running';
    return { overall, components };
  }

  /** A read-only view of the current graph (for an admin API). */
  snapshot(): TopologySnapshot {
    return {
      components: [...this.topology.components.values()].map((c) => ({
        id: c.id,
        kind: c.kind,
        type: c.type,
        inputs: c.inputs.map(formatInputRef),
      })),
    };
  }

  /** Subscribes to clones of events flowing out of `target`. Never affects the pipeline. */
  tap(target: TapTarget, options?: TapOptions): TapSubscription {
    return this.tapHub.subscribe(target, options);
  }

  // -----------------------------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------------------------

  private async instantiateComponents(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const built = this.topology.components.get(id)!;
      const abort = new AbortController();
      const { capacity, whenFull } = this.capacityFor(built);
      const inbox =
        built.kind === 'source' ? undefined : new EventChannel(`${id}.inbox`, capacity, whenFull);
      const router = built.kind === 'sink' ? undefined : new OutputRouter(id, built.declaredPorts);

      let buffer: EventBuffer | undefined;
      if (built.kind === 'sink' && built.bufferSpec?.kind === 'disk') {
        if (this.bufferFactory === undefined) {
          throw new FerruleError(
            'E_NO_BUFFER_FACTORY',
            `sink ${JSON.stringify(id)} requests a disk buffer but no bufferFactory is configured`,
          );
        }
        buffer = await this.bufferFactory(built.bufferSpec.disk ?? {}, {
          componentId: id,
          dataDir: built.dataDir,
          clock: this.clock,
          logger: this.logger.child({ component: id }),
        });
      }

      const pendingProducers = new Set(built.inputs.map((r) => r.componentId)).size;
      this.components.set(id, {
        id,
        kind: built.kind,
        type: built.type,
        built,
        state: 'starting',
        error: undefined,
        abort,
        inbox,
        buffer,
        pumpTask: undefined,
        router,
        runPromise: Promise.resolve(),
        mutex: new AsyncMutex(),
        pendingProducers,
        consumers: [],
      });
    }
  }

  private capacityFor(built: BuiltComponent): { capacity: ChannelCapacity; whenFull: WhenFull } {
    if (built.kind === 'sink') {
      const buf = built.bufferSpec;
      return {
        capacity: {
          events: buf?.maxEvents ?? this.topology.settings.defaultChannelCapacityEvents,
          bytes: buf?.maxBytes ?? this.topology.settings.defaultChannelCapacityBytes,
        },
        whenFull: buf?.whenFull ?? 'block',
      };
    }
    return {
      capacity: {
        events: this.topology.settings.defaultChannelCapacityEvents,
        bytes: this.topology.settings.defaultChannelCapacityBytes,
      },
      whenFull: 'block',
    };
  }

  /** Rebuilds every producer's routing table and every producer's consumer snapshot from scratch. */
  private rebuildRouting(): void {
    for (const rc of this.components.values()) rc.router?.reset();
    const consumerSets = new Map<string, Set<RunningComponent>>();
    for (const rc of this.components.values()) {
      if (rc.kind === 'source') continue;
      for (const ref of rc.built.inputs) {
        const producer = this.components.get(ref.componentId);
        if (producer?.router === undefined || rc.inbox === undefined) continue;
        producer.router.connect(ref.port, rc.inbox);
        const set = consumerSets.get(producer.id) ?? new Set<RunningComponent>();
        set.add(rc);
        consumerSets.set(producer.id, set);
      }
    }
    for (const rc of this.components.values()) rc.consumers = [...(consumerSets.get(rc.id) ?? [])];
  }

  // -----------------------------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------------------------

  private async startComponents(ids: readonly string[]): Promise<void> {
    const byKind = (kind: ComponentKind): RunningComponent[] =>
      ids.map((id) => this.components.get(id)!).filter((rc) => rc.kind === kind);
    const sinks = byKind('sink');
    const transforms = byKind('transform');
    const sources = byKind('source');

    if (this.topology.settings.healthchecksEnabled) {
      await Promise.all(sinks.map((rc) => this.runHealthcheck(rc)));
    }
    for (const rc of sinks) this.launch(rc);
    for (const rc of transforms) this.launch(rc);
    for (const rc of sources) this.launch(rc);
  }

  private async runHealthcheck(rc: RunningComponent): Promise<void> {
    const sink = rc.built.instance as Sink;
    if (sink.healthcheck === undefined) return;
    const ctx = this.baseContext(rc);
    const controller = new AbortController();
    const timeoutMs = this.topology.settings.healthcheckTimeoutMs;
    let expired = false;
    const timeout = this.clock
      .sleep(timeoutMs, controller.signal)
      .then(() => {
        expired = true;
      })
      .catch(() => undefined);
    try {
      await Promise.race([
        sink.healthcheck(ctx).then((v) => {
          controller.abort();
          return v;
        }),
        timeout,
      ]);
    } finally {
      controller.abort();
    }
    if (expired) {
      throw new FerruleError(
        'E_HEALTHCHECK_TIMEOUT',
        `healthcheck for ${JSON.stringify(rc.id)} timed out after ${timeoutMs}ms`,
      );
    }
  }

  private launch(rc: RunningComponent): void {
    rc.runPromise = this.driveComponent(rc);
  }

  private async driveComponent(rc: RunningComponent): Promise<void> {
    try {
      if (rc.kind === 'source') await this.runSource(rc);
      else if (rc.kind === 'transform') await this.runTransform(rc);
      else await this.runSink(rc);
      if (rc.state !== 'failed') rc.state = 'stopped';
    } catch (error) {
      this.handleFailure(rc, error);
    } finally {
      this.finishProducer(rc);
    }
  }

  private baseContext(rc: RunningComponent): ComponentContext {
    return {
      id: rc.id,
      type: rc.type,
      kind: rc.kind,
      logger: this.logger.child({
        component: rc.id,
        componentType: rc.type,
        componentKind: rc.kind,
      }),
      metrics: this.metrics.forComponent(rc.id, rc.kind, rc.type),
      clock: this.clock,
      signal: rc.abort.signal,
      dataDir: rc.built.dataDir,
      acknowledgements: this.topology.settings.acknowledgements,
    };
  }

  // -----------------------------------------------------------------------------------------
  // Sources
  // -----------------------------------------------------------------------------------------

  private async runSource(rc: RunningComponent): Promise<void> {
    const source = rc.built.instance as Source;
    rc.state = 'running';
    const ctx: SourceContext = { ...this.baseContext(rc), output: this.sourceOutput(rc) };
    await source.run(ctx);
  }

  private sourceOutput(rc: RunningComponent): SourceOutput {
    return {
      send: async (events, port = DEFAULT_PORT) => {
        const list = normalizeEvents(events);
        if (list.length === 0) return;
        let targets: EventChannel[];
        try {
          targets = rc.router!.targets(port);
        } catch (error) {
          for (const e of list) e.metadata.finalizers.finish('errored');
          throw error;
        }
        this.tapHub.publish(rc.id, port, list);
        this.recordSent(rc, list);
        if (targets.length === 0) {
          this.recordDiscarded(rc, list.length);
          for (const e of list) e.metadata.finalizers.finish('delivered');
          return;
        }
        const batches = distributeFanOut(list, targets.length);
        const admitted = await Promise.all(
          targets.map((channel, i) => channel.send(batches[i]!, rc.abort.signal)),
        );
        let dropped = 0;
        admitted.forEach((ok, i) => {
          if (ok) return;
          dropped += batches[i]!.length;
          for (const e of batches[i]!) e.metadata.finalizers.finish('errored');
        });
        if (dropped > 0) this.recordDiscarded(rc, dropped);
      },
    };
  }

  // -----------------------------------------------------------------------------------------
  // Transforms
  // -----------------------------------------------------------------------------------------

  private transformOutput(rc: RunningComponent): TransformOutput {
    return {
      push: (event, port = DEFAULT_PORT) => {
        let targets: EventChannel[];
        try {
          targets = rc.router!.targets(port);
        } catch (error) {
          event.metadata.finalizers.finish('errored');
          throw error;
        }
        this.tapHub.publish(rc.id, port, [event]);
        this.recordSent(rc, [event]);
        if (targets.length === 0) {
          this.recordDiscarded(rc, 1);
          event.metadata.finalizers.finish('delivered');
          return;
        }
        const batches = distributeFanOut([event], targets.length);
        targets.forEach((channel, i) => channel.pushSync(batches[i]!));
      },
    };
  }

  private async runTransform(rc: RunningComponent): Promise<void> {
    const transform = rc.built.instance as Transform;
    const ctx = this.baseContext(rc);
    const out = this.transformOutput(rc);
    transform.start?.(ctx);
    rc.state = 'running';

    const tickController = new AbortController();
    const onAbort = (): void => tickController.abort();
    rc.abort.signal.addEventListener('abort', onAbort);

    let tickLoop = Promise.resolve();
    if (transform.tickIntervalMs !== undefined && transform.tick !== undefined) {
      const intervalMs = transform.tickIntervalMs;
      const tick = transform.tick.bind(transform);
      tickLoop = (async () => {
        for (;;) {
          try {
            await this.clock.sleep(intervalMs, tickController.signal);
          } catch {
            return;
          }
          await rc.mutex.run(() => tick(this.clock.now(), out));
        }
      })();
    }

    for (;;) {
      let batch: Event[] | undefined;
      try {
        batch = await rc.inbox!.receiveBatch({}, rc.abort.signal);
      } catch (error) {
        if (rc.abort.signal.aborted) break;
        throw error;
      }
      if (batch === undefined) break;
      if (batch.length === 0) continue;
      this.recordReceived(rc, batch);
      const events = batch;
      try {
        await rc.mutex.run(() => transform.process(events, out));
      } catch (error) {
        // process() is documented to fail the component only as a last resort (a bug); when it
        // does, the whole batch's outcome is unknowable, so it is finalized errored rather than
        // left to hang a source's acknowledgement forever. Already-forwarded events' finalizers
        // may already be finishing downstream; finishing them again here is a safe no-op.
        for (const e of events) e.metadata.finalizers.finish('errored');
        throw error;
      }
    }

    tickController.abort();
    rc.abort.signal.removeEventListener('abort', onAbort);
    await tickLoop;
    await rc.mutex.run(() => transform.flush?.(out));
  }

  // -----------------------------------------------------------------------------------------
  // Sinks
  // -----------------------------------------------------------------------------------------

  private async runSink(rc: RunningComponent): Promise<void> {
    const sink = rc.built.instance as Sink;
    const input: SinkInput =
      rc.buffer !== undefined ? this.bufferSinkInput(rc) : this.instrumentedInbox(rc);
    if (rc.buffer !== undefined) this.startPump(rc);
    const ctx: SinkContext = { ...this.baseContext(rc), input };
    rc.state = 'running';
    await sink.run(ctx);
    if (rc.pumpTask !== undefined) await rc.pumpTask.catch(() => undefined);
  }

  private instrumentedInbox(rc: RunningComponent): SinkInput {
    const channel = rc.inbox!;
    const record = (batch: Event[]): void => this.recordReceived(rc, batch);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const batch of channel) {
          record(batch);
          yield batch;
        }
      },
    };
  }

  private startPump(rc: RunningComponent): void {
    const channel = rc.inbox!;
    const buffer = rc.buffer!;
    rc.pumpTask = (async () => {
      for (;;) {
        let batch: Event[] | undefined;
        try {
          batch = await channel.receiveBatch({}, rc.abort.signal);
        } catch (error) {
          if (rc.abort.signal.aborted) break;
          throw error;
        }
        if (batch === undefined) break;
        if (batch.length === 0) continue;
        this.recordReceived(rc, batch);
        try {
          await buffer.writer.write(batch, rc.abort.signal);
        } catch (error) {
          if (rc.abort.signal.aborted) break;
          throw error;
        }
      }
      await buffer.writer.close();
    })();
  }

  private bufferSinkInput(rc: RunningComponent): SinkInput {
    const reader = rc.buffer!.reader;
    const batchSize = 1000;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const batch = await reader.read(batchSize);
          if (batch === undefined) return;
          if (batch.length > 0) yield batch;
        }
      },
    };
  }

  // -----------------------------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------------------------

  private recordReceived(rc: RunningComponent, batch: readonly Event[]): void {
    const m = this.metrics.forComponent(rc.id, rc.kind, rc.type);
    m.counter(Metrics.receivedEvents).increment(batch.length);
    m.counter(Metrics.receivedBytes).increment(sumBytes(batch));
  }

  private recordSent(rc: RunningComponent, events: readonly Event[]): void {
    const m = this.metrics.forComponent(rc.id, rc.kind, rc.type);
    m.counter(Metrics.sentEvents).increment(events.length);
    m.counter(Metrics.sentBytes).increment(sumBytes(events));
  }

  private recordDiscarded(rc: RunningComponent, count: number): void {
    this.metrics
      .forComponent(rc.id, rc.kind, rc.type)
      .counter(Metrics.discardedEvents)
      .increment(count);
  }

  // -----------------------------------------------------------------------------------------
  // Shutdown cascade & failure handling
  // -----------------------------------------------------------------------------------------

  private finishProducer(rc: RunningComponent): void {
    for (const consumer of rc.consumers) {
      consumer.pendingProducers--;
      if (consumer.pendingProducers <= 0) consumer.inbox?.close();
    }
  }

  private handleFailure(rc: RunningComponent, error: unknown): void {
    rc.state = 'failed';
    rc.error = describeError(new ComponentFailureError(rc.id, rc.kind, error));
    this.metrics.forComponent(rc.id, rc.kind, rc.type).counter(Metrics.errors).increment();
    this.logger.error('component failed', {
      component: rc.id,
      kind: rc.kind,
      type: rc.type,
      error: error instanceof Error ? error.message : String(error),
    });
    if (rc.inbox !== undefined && !rc.inbox.isClosed) {
      for (const e of rc.inbox.drain()) e.metadata.finalizers.finish('errored');
    }
    if (!this.topology.settings.continueOnComponentFailure) void this.stop();
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    for (const rc of this.components.values()) {
      if (rc.state === 'running' || rc.state === 'starting') rc.state = 'stopping';
    }
    for (const rc of this.components.values()) {
      if (rc.kind === 'source') rc.abort.abort(new ShutdownError());
    }

    const allDone = (): Promise<void[]> =>
      Promise.all(
        [...this.components.values(), ...this.retiring].map((rc) =>
          rc.runPromise.catch(() => undefined),
        ),
      );
    const deadlineMs = this.topology.settings.shutdownDeadlineMs;
    const expired = await timedOut(allDone(), deadlineMs, this.clock);
    if (expired) {
      this.logger.warn('shutdown deadline exceeded; force-finalizing remaining events', {
        deadlineMs,
      });
      for (const rc of this.components.values()) {
        rc.abort.abort(new ShutdownError('shutdown deadline exceeded'));
        if (rc.inbox !== undefined) {
          for (const e of rc.inbox.drain()) e.metadata.finalizers.finish('errored');
        }
      }
      for (const rc of this.retiring) {
        rc.abort.abort(new ShutdownError('shutdown deadline exceeded'));
      }
      await allDone();
    }
    this.tapHub.closeAll();
    for (const rc of this.components.values()) if (rc.state !== 'failed') rc.state = 'stopped';
    this.stopping = false;
    this.stopped = true;
  }

  /** Retires a component replaced or removed by {@link reload}, outside the shutdown cascade. */
  private async drainAndStop(rc: RunningComponent, deadlineMs: number): Promise<void> {
    rc.consumers = [];
    if (rc.kind === 'source') rc.abort.abort(new ShutdownError('retired by reload'));
    else rc.inbox?.close();

    const expired = await timedOut(rc.runPromise, deadlineMs, this.clock);
    if (expired) {
      rc.abort.abort(new ShutdownError('reload drain deadline exceeded'));
      if (rc.inbox !== undefined) {
        for (const e of rc.inbox.drain()) e.metadata.finalizers.finish('errored');
      }
      await rc.runPromise.catch(() => undefined);
    }
  }
}
