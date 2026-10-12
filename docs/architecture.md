# Ferrule architecture

This document describes how Ferrule is put together: the data model, the packages, how events
move through a running pipeline, and the guarantees each layer provides. It is the reference
for design decisions; when code and this document disagree, one of them is a bug.

## 1. Goals and non-goals

**Goals**

- Process logs, metrics, and traces in one pipeline with one configuration model.
- Make transforms safe: type errors and unhandled failure cases are rejected when a pipeline
  loads, not discovered in production.
- Bounded memory under any input rate. Overload results in backpressure (or explicit,
  counted shedding), never unbounded queues.
- At-least-once delivery when a disk buffer is configured, with end-to-end acknowledgements
  back to sources that support them.
- Reconfigure a running pipeline without losing in-flight events.
- Be extensible in TypeScript without forking.

**Non-goals**

- Long-term storage or querying. Ferrule moves and shapes data; it does not index it.
- Exactly-once delivery. Sinks that support idempotent writes can get effectively-once
  behaviour, but the pipeline contract is at-least-once.
- A general-purpose programming language. Ferrule Script is deliberately small and total.

## 2. Data model (`@ferrule/core`)

### 2.1 Values

Every field in an event is a `Value`:

| Kind        | JavaScript representation | Notes                                             |
| ----------- | ------------------------- | ------------------------------------------------- |
| `null`      | `null`                    |                                                   |
| `boolean`   | `boolean`                 |                                                   |
| `integer`   | `bigint`                  | Signed 64-bit; arithmetic wraps like int64        |
| `float`     | `number`                  | IEEE-754 double                                   |
| `string`    | `string`                  |                                                   |
| `bytes`     | `Uint8Array`              | Raw payloads, trace/span IDs                      |
| `timestamp` | `Timestamp`               | Nanoseconds since the Unix epoch (`bigint`)       |
| `array`     | `Value[]`                 |                                                   |
| `object`    | `Map<string, Value>`      | Insertion-ordered; no prototype-pollution surface |

Integers and floats are distinct kinds because telemetry protocols distinguish them (OTLP
`int_value` vs `double_value`, counters vs gauges) and because JSON's single number type loses
information that downstream systems care about. The lossless JSON codec keeps `1` and `1.0`
apart and preserves integers beyond 2⁵³.

Objects are `Map`s rather than plain objects so that untrusted keys such as `__proto__` are
ordinary data and key order is exactly insertion order (plain objects reorder integer-like
keys).

### 2.2 Events

There are three event kinds, each carrying `EventMetadata`:

- **`LogEvent`** — a root object of fields. Most sources produce these.
- **`MetricEvent`** — a series (name, optional namespace, string tags), a kind (`incremental`
  or `absolute`), a typed value (counter, gauge, set, distribution, histogram, summary), and an
  optional timestamp and interval.
- **`SpanEvent`** — one span of a trace: IDs, timing, status, attributes, events, links, and
  resource/scope attributes.

`EventMetadata` records where the event came from (`sourceId`), when Ferrule received it, and
its **finalizers**.

### 2.3 Acknowledgements

Sources that can acknowledge upstream (HTTP with response codes, Kafka offsets, file
checkpoints) create a `BatchNotifier` per unit of work and attach an `EventFinalizer` to each
event. When an event is fanned out to several sinks, its finalizers are cloned, so the batch
completes only when every copy reaches a terminal state. The batch's status is the _worst_ of
its events' statuses (`rejected` > `errored` > `delivered`), and the source acts on it: commit
the offset, advance the checkpoint, or return an error to the client so it retries.

A batch is **sealed** by its source after all events are attached, so it cannot complete early
while events are still being produced.

## 3. Packages

```
                           ┌──────────────┐
                           │     cli      │
                           └──────┬───────┘
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
        ┌──────────┐        ┌───────────┐        ┌───────────┐
        │  admin   │        │  config   │        │    lsp    │
        └────┬─────┘        └─────┬─────┘        └─────┬─────┘
             │                    │                    │
             ▼                    ▼                    │
        ┌───────────────────────────────────┐          │
        │              runtime              │          │
        └──┬───────────┬───────────┬────────┘          │
           ▼           ▼           ▼                   │
      ┌─────────┐ ┌──────────┐ ┌─────────┐             │
      │ sources │ │operators │ │  sinks  │             │
      └────┬────┘ └────┬─────┘ └────┬────┘             │
           │           │            │                  │
           ▼           ▼            ▼                  ▼
      ┌─────────┐ ┌──────────────────────────────────────┐
      │ codecs  │ │               script                 │
      └────┬────┘ └─────────────────┬────────────────────┘
           │                        │
           ▼                        ▼
      ┌────────────────────────────────────────────────────┐
      │                       core                         │
      └────────────────────────────────────────────────────┘
      (buffer depends on core; runtime depends on buffer)
```

| Package     | Responsibility                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `core`      | Values, events, timestamps, paths, lossless JSON, metric arithmetic, acks                                        |
| `script`    | Ferrule Script: lexer, parser, resolver, type checker, optimizer, compiler, stdlib                               |
| `codecs`    | Framing and decoding/encoding: protobuf wire, OTLP, syslog, logfmt, Prometheus text, StatsD, CSV, patterns       |
| `buffer`    | Crash-safe disk buffer: segmented WAL, checksums, recovery, acknowledgement-driven truncation                    |
| `runtime`   | Bounded channels, topology graph, component lifecycle, retry, circuit breakers, hot reload                       |
| `operators` | Built-in transforms: route, filter, aggregate, dedup, cardinality limit, log-to-metric, tail sampling            |
| `sources`   | HTTP, OTLP/HTTP, syslog (TCP/UDP), file tailing, StatsD, internal metrics                                        |
| `sinks`     | HTTP/webhook, object storage, ClickHouse, Postgres, Loki-compatible push, Kafka-protocol producer, console, file |
| `config`    | Config file loading (YAML/JSON), schema validation, env interpolation, secret handling, topology diffing         |
| `admin`     | Admin HTTP API: health, topology, component metrics, live `tap`                                                  |
| `cli`       | The `ferrule` command: `run`, `validate`, `test`, `tap`, `fmt`, `repl`, `bench`                                  |
| `lsp`       | Language server for Ferrule Script (diagnostics, hover, completion, formatting)                                  |
| `testkit`   | Utilities for testing pipelines and custom components                                                            |

Dependency direction is strictly downward. `core` has no dependencies, and no package imports
from a package above it. This is enforced by TypeScript project references.

## 4. Runtime model

### 4.1 Topology

A pipeline is a directed acyclic graph of components. Each component is one of:

- **Source**: produces events. Has no inputs.
- **Transform**: consumes and produces events. A Ferrule Script program or a built-in operator.
- **Sink**: consumes events and delivers them outside Ferrule.

Components are connected by **bounded channels**. A channel has a capacity measured in events
_and_ in estimated bytes; whichever limit is hit first blocks the sender. Fan-out (one output,
several consumers) clones events lazily: the first consumer gets the original, and later
consumers get copies only if a consumer mutates.

### 4.2 Backpressure

Senders `await` channel capacity. Sources translate this into protocol-level pushback: HTTP
sources delay responses (and eventually return 503 with `Retry-After`), TCP sources stop
reading from sockets, file sources stop reading. Each sink chooses what happens when it is
overwhelmed: `block` (the default, which propagates backpressure) or `drop_newest` (counted
and reported).

### 4.3 Execution

Ferrule runs on a single Node.js event loop per process by default. A transform implements
exactly one of two contracts: `process`, a synchronous function over a batch of events, which
keeps per-event overhead low and ordering trivially deterministic; or `processAsync`, for a
transform that must await something per batch (an external lookup, or handing work to a
`worker_threads` pool) without blocking the event loop for every other component while it does.
The runtime awaits `processAsync` between batches the same way it would a slow `process` call —
the next batch, a due `tick()`, and `flush()` all wait for it — so ordering and backpressure on
that transform's inbox are identical either way; only the event loop is free in between. To use
more cores for everything else, run several Ferrule processes and split inputs between them (for
example several file sources over disjoint globs, or several instances behind a load balancer).

For a single CPU-heavy transform, `@ferrule/runtime`'s `WorkerPool` gives one component access to
several cores without a second process: a fixed set of `worker_threads`, each running the same
entry module, exchanging `{ meta, payload }` pairs keyed by an internally assigned request id.
`payload` crosses the thread boundary by transfer, not by the structured-clone algorithm walking
a (possibly deep) event graph — this is exactly why the binary event encoding in `@ferrule/buffer`
exists: a transform that uses the pool encodes the events it hands to a worker with that codec,
and decodes what comes back, instead of ever structured-cloning an `Event`. A worker that crashes
(exits non-zero, or errors) has its in-flight request retried once on a fresh worker; a second
crash gives up and reports it to the caller, which decides what that means for the data (for
`script`, finishing those events `errored`). `@ferrule/operators`' `script` transform's
`workers: <n>` option is the pool's first user: each batch's log events are split into up to `n`
chunks, run concurrently (through `processAsync`, never `process`), and reattached to the
original events by position — metadata the binary codec doesn't carry, chiefly finalizers, never
leaves the main thread. See `packages/runtime/README.md`'s "Worker pool" section and
`packages/operators/README.md`'s "Worker pool (CPU-heavy `script`)" for the full design,
including how a worker entry module is resolved and run.

### 4.4 Disk buffer

A sink can have a disk buffer in front of it. The buffer is a **segmented write-ahead log**:

- Records are length-prefixed and CRC-32C checksummed.
- Segments roll over at a size limit. A segment is deleted once every record in it has been
  acknowledged by the sink.
- On startup, recovery validates every segment, truncates a partially written tail record,
  skips (and reports) corrupt records in sealed segments, and resumes from the last
  acknowledged position.
- Writers batch `fsync` calls, with a configurable `sync` policy (`always`, `interval`, `none`).
- Once a write is durable, the buffer finishes the events' upstream finalizers, so the source
  can acknowledge its client. Events read back carry fresh finalizers. `delivered` and
  `rejected` release a record; `errored` keeps it, so it is redelivered after a restart.
  Acknowledgement advances over the contiguous acknowledged prefix, which makes delivery
  at-least-once.

Crash safety is tested with a fault-injecting filesystem shim that tears writes at every byte
offset.

### 4.5 Hot reload

On a configuration change, the new config is validated and compiled completely before anything
in the running pipeline is touched. The runtime then diffs the old and new topologies:
unchanged components keep running, removed components are drained and stopped, added
components are started, and changed components are replaced after their inputs are
redirected. Buffers survive reloads.

## 5. Ferrule Script

Ferrule Script is the transform language. See [language/design.md](language/design.md) for the
full design. Architecturally:

```
source text → lexer → parser → AST → resolver → type checker → optimizer → closure compiler
                                         │              │
                                         └──── diagnostics (spans, codes, fix hints) ──→ CLI / LSP
```

- **Compile, don't interpret.** The compiler turns the checked AST into a tree of
  pre-specialized JavaScript closures. Type information chooses the specialized operation (for
  example integer addition with 64-bit wrapping vs float addition), so there is no dynamic type
  dispatch per event on hot paths.
- **No `eval`.** Programs never become JavaScript source text.
- **Fallibility is in the type system.** Every expression has a type and a _fallible_ flag. A
  fallible expression must be handled with `??`, `!`, or a `match`/`try` before it can be used.
  The checker rejects programs that ignore failure.
- **Termination is guaranteed.** There are no unbounded loops or recursion. Iteration is through
  bounded higher-order functions over finite collections.

## 6. Configuration

Pipelines are declared in YAML (JSON is also accepted):

```yaml
data_dir: /var/lib/ferrule

sources:
  app_logs:
    type: http_server
    address: 0.0.0.0:8080
    decoding: { codec: json }

transforms:
  shape:
    type: script
    inputs: [app_logs]
    source: |
      .service = .service ?? "unknown"
      del(.debug)

sinks:
  store:
    type: clickhouse
    inputs: [shape]
    url: https://clickhouse.internal:8443
    database: telemetry
    table: logs
    auth:
      strategy: basic
      username: ferrule
      password: ${secret:CLICKHOUSE_PASSWORD}
    buffer:
      type: disk
      max_size: 2GiB
```

Validation happens in layers: syntax, schema (each component type declares a typed option
schema), graph checks (unknown inputs, cycles, orphaned components), and script compilation.
Errors report the file, line, and column.

## 7. Observability of Ferrule itself

Every component emits internal metrics (events in and out, bytes, errors, buffer depth,
backpressure time) through an `internal_metrics` source, so they can be routed like any other
telemetry. The admin API exposes health, the live topology, and `tap`, which streams sampled
events at any edge of the graph for debugging, with secrets redacted.

## 8. Testing strategy

| Layer            | Approach                                                                         |
| ---------------- | -------------------------------------------------------------------------------- |
| Parsers & codecs | Example tests + property tests (round-trip, never-throws-untyped) + fuzz corpora |
| Language         | Golden tests: source → expected diagnostics / expected output events             |
| Disk buffer      | Fault-injection filesystem; crash at every write offset, then verify recovery    |
| Runtime          | Deterministic scheduler tests for backpressure, reload, and shutdown             |
| Connectors       | In-process fake servers; a small container-based integration tier                |
| End to end       | Pipelines defined in YAML, driven by `ferrule test` fixtures                     |
| Performance      | Benchmarks per hot path, tracked in CI to catch regressions                      |
