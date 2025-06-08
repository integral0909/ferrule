# `@ferrule/runtime`

The pipeline runtime: bounded channels, topology validation and construction, component
lifecycle, graceful shutdown, hot reload, a tap API, and a toolkit for building sinks
(batching, retry, circuit breaking, concurrency limiting). This package implements the
[architecture doc's](../../docs/architecture.md) §4 "Runtime model" and the M4 roadmap item,
except the disk-backed event buffer itself (`@ferrule/buffer`, built separately) — this package
only defines the `EventBuffer` interface and a factory hook a disk implementation plugs into.

## Contents

- [Architecture](#architecture)
- [Component authoring guide](#component-authoring-guide)
- [Topology](#topology)
- [Buffers and acknowledgements](#buffers-and-acknowledgements)
- [Sink toolkit](#sink-toolkit)
- [Testing helpers](#testing-helpers)

## Architecture

A running `Pipeline` is a graph of **sources**, **transforms**, and **sinks** (the contract for
each lives in `component.ts` and does not change here) connected by `EventChannel`s:

```
                    ┌───────────┐        ┌────────────┐        ┌────────────┐
  Source.run() ───▶ │  channel  │ ─────▶ │  Transform  │ ─────▶ │  channel   │ ─────▶ Sink.run()
  (SourceOutput)    │ (inbox of │        │  .process() │        │ (inbox of  │        (SinkInput)
                     the        │        │  .tick()    │         the sink,  │
                     transform) │        │  .flush()   │         optionally │
                    └───────────┘        └────────────┘         behind an   │
                                                                  EventBuffer│
                                                                  └──────────┘
```

Every transform and sink has exactly one **inbox** (`EventChannel`): a bounded, FIFO queue with
a capacity in both event count and estimated bytes (`Event.estimatedSize()`). Multiple upstream
producers can feed the same inbox (they are served fairly, first-come-first-served); a single
producer's output can fan out to several inboxes, in which case every consumer past the first
gets a **clone** (`Event.clone()`, which clones finalizers too) so acknowledgements track each
copy independently and mutating one consumer's copy never affects another's.

`Pipeline` records `component_received_events_total` / `component_sent_events_total` (and the
`_bytes` counterparts) automatically at these channel boundaries; components only need to record
their own metrics (`component_errors_total`, request durations, etc.) via `ctx.metrics`.

### Startup and shutdown

`pipeline.start()` runs sink healthchecks (in parallel, with a timeout, skippable via
`settings.healthchecksEnabled`), then starts every component: sinks first, then transforms, then
sources — so nothing produced by a source is ever dropped for lack of a running consumer.

`pipeline.stop()` is graceful: it aborts every source's `ctx.signal`. As each source's `run()`
returns, the runtime decrements a "pending producers" counter on everything that source fed; once
a component's count reaches zero (all of its upstream producers are done), its inbox is closed.
A transform drains its inbox, calls `flush()`, and finishes; a sink's `ctx.input` ends once its
inbox (and buffer, if any) is drained, and it finishes when `run()` returns. This cascades
sources → transforms → sinks without the runtime needing to wait on each stage sequentially.

If `settings.shutdownDeadlineMs` (default 30s) elapses before everything has stopped, the runtime
force-aborts every remaining component and **finalizes any events still sitting in a memory
channel as `errored`**, so a source's `BatchNotifier` never hangs. Events already handed to a
_disk_-backed `EventBuffer` are left alone — that is the correct behaviour for a durable buffer,
which is expected to redeliver them after a restart; only best-effort, in-memory queueing is
force-finalized.

### Component failure

If a component's `run()` throws (or a transform's `process()`/`tick()`/`flush()` does, or a
component pushes to a port it never declared — `InvalidPortError`, which is always a bug), the
runtime logs it, increments `component_errors_total`, marks the component `failed`, and finishes
any events it was holding (its own inbox, or the batch it was processing when it crashed) as
`errored` so acknowledgements never hang. By default this then stops the whole pipeline
(`settings.continueOnComponentFailure: false`); set it to `true` to isolate the failing component
instead and keep the rest of the graph running (`pipeline.health().overall` reports `degraded`
rather than `failed` in that case).

### Hot reload

`pipeline.reload(newSpec)` validates and **fully builds** the new topology first — including
calling `build()` on every component, even ones that turn out to be unchanged — before touching
anything running. If that fails, the result is `{ ok: false, errors }` and the running pipeline
is untouched.

It then diffs the new topology against the current one by component ID, comparing `type`,
`options` (deep equality), and `inputs`:

- **unchanged** (identical on all three): keeps the _existing_ running instance, including its
  inbox channel and — for a sink — its `EventBuffer`. The freshly built duplicate instance from
  the validation pass above is simply discarded.
- **added**: the freshly built instance starts.
- **removed**: the running instance's inbox is closed immediately (it drains whatever it already
  had buffered) and it is given `settings.shutdownDeadlineMs` to finish before being force-
  aborted, in the background — `reload()` does not block on this.
- **changed**: treated as remove-old + add-new. The old instance's inbox is closed and it drains
  in the background exactly like a removed component; the new instance starts immediately with a
  fresh inbox.

Every producer's routing table is rebuilt from scratch after a reload, so an _unchanged_ producer
correctly starts feeding a newly added consumer, or stops feeding a removed one, without needing
its own instance to change.

### Tap

`pipeline.tap({ componentId, port? }, options?)` returns an `AsyncIterable<Event>` of **clones**
of whatever flows out of that component's port, with optional sampling (`sampleRate`) and a
token-bucket rate limit (`maxEventsPerSecond`). Delivery never blocks the pipeline and never
shares an object with it: a full subscriber queue drops its oldest entry rather than applying
backpressure. This is what `ferrule tap` and the admin API's live tap are built on.

## Component authoring guide

Every component is built from validated options via a `SourceDefinition` / `TransformDefinition`
/ `SinkDefinition` (see `component.ts`), registered in a `ComponentRegistry`. A minimal example of
each kind:

```ts
import { s } from '@ferrule/schema';
import { LogEvent } from '@ferrule/core';
import { defineSource, defineTransform, defineSink, DEFAULT_PORT } from '@ferrule/runtime';

// A source: produces events until ctx.signal aborts.
const heartbeat = defineSource({
  kind: 'source',
  type: 'heartbeat',
  description: 'emits one log event per interval',
  options: s.object({ intervalMs: s.duration().default(1000) }),
  produces: () => ['log'],
  build: (options) => ({
    async run(ctx) {
      while (!ctx.signal.aborted) {
        await ctx.output.send(LogEvent.fromMessage('tick'));
        try {
          await ctx.clock.sleep(options.intervalMs, ctx.signal);
        } catch {
          return;
        }
      }
    },
  }),
});

// A transform: synchronous batches; must never throw for bad *data* (route to an error port or
// finish the event's finalizers instead), only for a genuine bug.
const upcase = defineTransform({
  kind: 'transform',
  type: 'upcase',
  description: 'uppercases the message field',
  options: s.object({}),
  accepts: ['log'],
  build: () => ({
    process(events, out) {
      for (const event of events) {
        const log = event as LogEvent;
        const message = log.get('message');
        if (typeof message === 'string') log.set('message', message.toUpperCase());
        out.push(event, DEFAULT_PORT);
      }
    },
  }),
});

// A sink: consumes ctx.input until it ends; must finish every event's finalizers.
const console_sink = defineSink({
  kind: 'sink',
  type: 'console',
  description: 'writes events to a stream',
  options: s.object({}),
  accepts: ['log', 'metric', 'span'],
  build: (_options, ctx) => ({
    async run(sinkCtx) {
      for await (const batch of sinkCtx.input) {
        for (const event of batch) {
          ctx.logger.info('event', { event });
          event.metadata.finalizers.finish('delivered');
        }
      }
    },
  }),
});
```

Guidelines that follow directly from the contract in `component.ts`:

- **Never throw for bad data.** A transform that hits malformed input should route the event to
  `ERROR_PORT` (if it declares that port via `outputs()`) or drop it and count
  `discardedEvents`. Throwing is reserved for genuine bugs and fails the whole component.
- **Every event's finalizers must be finished.** A sink must finish every event it receives
  (`delivered`, `errored` after retries are exhausted, or `rejected` for a permanent failure). A
  transform that drops an event intentionally must finish it too (`delivered` if that's
  deliberate, `rejected` if the data was bad). Events a transform pushes onward transfer
  ownership of their finalizers to whatever eventually consumes them.
- **Declare every port you push to.** `outputs()` lists ports beyond the default one; pushing to
  an undeclared port is a bug and fails the component (`InvalidPortError`).
- **Use `ctx.clock`, not `setTimeout`/`Date.now()`,** for anything time-based, so components are
  testable with `ManualClock` and so the runtime's shutdown deadlines stay coherent with a
  component's own timers.

## Topology

A `TopologySpec` is the programmatic (not YAML) representation of a pipeline:

```ts
interface TopologySpec {
  sources: Record<string, { type: string; options: unknown }>;
  transforms?: Record<string, { type: string; options: unknown; inputs: readonly string[] }>;
  sinks: Record<
    string,
    {
      type: string;
      options: unknown;
      inputs: readonly string[];
      buffer?: {
        whenFull?: 'block' | 'drop_newest'; // default 'block'
        kind?: 'memory' | 'disk'; // default 'memory'
        maxEvents?: number; // memory only
        maxBytes?: number; // memory only
        disk?: Record<string, unknown>; // passed to bufferFactory when kind: 'disk'
      };
    }
  >;
  settings?: {
    dataDir?: string;
    defaultChannelCapacityEvents?: number; // default 10_000
    defaultChannelCapacityBytes?: number; // default 64MiB
    acknowledgements?: boolean; // default false
    healthchecksEnabled?: boolean; // default true
    healthcheckTimeoutMs?: number; // default 5_000
    shutdownDeadlineMs?: number; // default 30_000
    continueOnComponentFailure?: boolean; // default false
  };
}
```

An input reference is `componentId` (the component's default port) or `componentId.port`.

**Design choice, documented as asked for:** `options` here is _raw_, unvalidated input (as a
config loader would hand it over from YAML/JSON). `buildTopology(spec, registry)` validates it
against each component definition's own `Schema<Options>` and reports every issue with a path —
this keeps `@ferrule/runtime` usable standalone (as this package's tests do) without depending on
`@ferrule/config`'s loader, and it means a hot reload's "options changed?" diff is comparing the
same validated, typed values the components themselves see.

`buildTopology` never throws; it returns
`{ ok: true, topology, warnings } | { ok: false, errors, warnings }`, collecting **every** issue
in one pass:

| Code                                                  | Severity | Meaning                                                           |
| ----------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| `E_DUPLICATE_ID`                                      | error    | a component ID is reused across sources/transforms/sinks          |
| `E_UNKNOWN_COMPONENT_TYPE`                            | error    | `type` isn't registered (with a did-you-mean suggestion)          |
| `E_SCHEMA`                                            | error    | options failed the definition's schema (one per invalid field)    |
| `E_UNKNOWN_INPUT`                                     | error    | an input references a component ID that doesn't exist             |
| `E_SINK_AS_INPUT`                                     | error    | an input references a sink, which has no outputs                  |
| `E_UNKNOWN_PORT`                                      | error    | an input references a port the producer never declared            |
| `E_CYCLE`                                             | error    | the graph has a cycle (message includes the full cycle path)      |
| `E_EVENT_KIND_MISMATCH`                               | error    | a consumer's `accepts` shares no kind with its inputs' `produces` |
| `E_NO_INPUTS`                                         | error    | a transform or sink has an empty `inputs` list                    |
| `E_COMPONENT_BUILD_FAILED` / definition-specific code | error    | `build()` threw                                                   |
| `W_UNUSED_SOURCE`                                     | warning  | a source is never referenced as an input by anything              |

On success, `buildTopology` also builds every component instance (calling `definition.build`),
so `ferrule validate` and hot reload both get "did this actually build" checking, not just graph
shape checking.

## Buffers and acknowledgements

Every sink has one `EventChannel` inbox. By default (`buffer` omitted or `kind: 'memory'`), that
channel _is_ the sink's memory buffer — sized by `buffer.maxEvents` / `buffer.maxBytes` (falling
back to the pipeline's default channel capacity) and governed by `buffer.whenFull`.

`whenFull: 'block'` (the default) propagates backpressure to whatever feeds the sink. `whenFull:
'drop_newest'` drops an incoming batch that doesn't fit rather than waiting for space, and — this
runtime's channel `send()` reports back whether a batch was admitted or dropped specifically so
this can happen — **finalizes the dropped events as `errored`**, so a source's `BatchNotifier`
is told about the loss instead of hanging forever.

For `buffer: { kind: 'disk' }`, the pipeline calls the `bufferFactory` supplied in
`PipelineOptions` (there is no default; starting a pipeline with such a sink and no factory
configured fails fast with `E_NO_BUFFER_FACTORY`) to build an `EventBuffer`:

```ts
interface EventBuffer {
  readonly writer: { write(events, signal?): Promise<void>; close(): Promise<void> };
  readonly reader: { read(max, signal?): Promise<Event[] | undefined>; close(): Promise<void> };
  stats(): { events: number; bytes: number };
  close(): Promise<void>;
}

type EventBufferFactory = (
  options: Record<string, unknown>, // the sink's `buffer.disk` options, raw
  ctx: { componentId: string; dataDir: string | undefined; clock: Clock; logger: Logger },
) => EventBuffer | Promise<EventBuffer>;
```

The pipeline still keeps a small inbox channel in front of even a disk-backed sink (producers
always write to an `EventChannel`); a background pump moves events from that inbox into the
buffer's writer, and the sink's `ctx.input` reads from the buffer's reader. This means a disk
implementation (`@ferrule/buffer`, built separately, deliberately not imported here) only has to
implement the four `EventBuffer` methods — it does not need to know anything about channels,
fan-out, or the component contract.

`createMemoryEventBuffer(id, capacity)` is the in-memory `EventBuffer` used for the default case,
and is also handy as a fake in tests for anything that expects a real `EventBufferFactory`.

## Sink toolkit

`packages/runtime/src/toolkit` (also exported from the package root) gives connector authors the
pieces to build a batching, retrying sink without reimplementing them:

- **`Batcher<T>`** — groups items by count, estimated size, and a timeout, optionally partitioned
  by a key function; every item passed to `add()` is eventually flushed exactly once.
- **`RetryPolicy`** — exponential backoff with full jitter (`random(0, min(cap, initial *
multiplier^attempt))`), bounded by attempts and/or elapsed time, and never returns a delay
  shorter than a server-provided `retryAfterMs`.
- **`CircuitBreaker`** — closed / open / half-open, with a bounded number of half-open trials.
- **`FixedConcurrencyLimiter`** / **`AdaptiveConcurrencyLimiter`** — a constant cap, or an AIMD
  limiter that grows by one after a run of fast, successful completions and shrinks
  multiplicatively on an error or a completion slower than a configured threshold.
- **`SinkError`** (`.retryable(...)` / `.permanent(...)`) and `classifySinkError` — anything a
  sink's `send` throws that isn't already a `SinkError` is treated as retryable by default;
  permanence must be asserted explicitly.
- **`runBatchedSink(ctx, { maxEvents?, maxBytes?, timeoutMs?, partitionKey?, encode?, send, retry?, concurrency?, breaker? })`**
  ties all of the above together: it consumes `ctx.input`, batches, delivers with retry and
  bounded concurrency, and finishes every event's finalizers with `delivered` / `errored` (retries
  exhausted) / `rejected` (a permanent failure), so a sink built on it only has to implement
  `send`.

## Testing helpers

`@ferrule/runtime/testing` (also re-exported from the package root, since this monorepo's Vitest
alias only resolves the bare package name) provides:

- **`ManualClock`** — deterministic time: `advance(ms)` resolves every due sleep in deadline
  order, yielding between each so chained timeouts behave like real ones; `tick()` steps to the
  next one.
- **`createCapturingLogger()`** — a `Logger` that records `{ level, message, fields }` instead of
  writing anywhere.
- **`createTestSourceContext()` / `createTestTransformContext()` / `createTestSinkContext()`** —
  a `ManualClock`-backed `ComponentContext` plus the kind-specific piece (a recording
  `SourceOutput`, a recording `TransformOutput`, or a manually-fed `SinkInput`), for unit-testing
  one component without a running pipeline.
- **`createCollectingSinkDefinition(options?)`** — a real `SinkDefinition` that records every
  event and batch it receives, with a caller-controlled finish status, for pipeline-level tests.
- **`createScriptedSourceDefinition(steps, options?)`** — a real `SourceDefinition` that sends a
  scripted sequence of event batches (each with its own `BatchNotifier`, so its completion status
  is observable) and then idles until aborted, like a well-behaved source.

See `packages/runtime/test/` for extensive examples of all of the above, including full
pipeline tests that assert on acknowledgement status reaching a scripted source's
`BatchNotifier`.
