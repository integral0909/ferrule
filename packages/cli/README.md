# `@ferrule/cli`

The `ferrule` command-line interface: run pipelines, validate configuration, test them, inspect a
running instance, format and evaluate Ferrule Script, and scaffold new configs. This package
implements the [architecture doc's](../../docs/architecture.md) `cli` row and the M8 roadmap item's
CLI half. It depends on every other package (`core` through `admin`, `testkit`, `lsp`) but is
itself a thin layer: argument parsing, wiring the right packages together, and rendering their
output — the actual work (loading config, building topologies, running pipelines, checking
scripts) always happens in the package that owns it.

Node.js standard library only — the argument parser, help text, REPL, and `top` table are all
hand-written; no `commander`/`yargs`/third-party dependency of any kind.

## Contents

- [Install / run](#install--run)
- [Global behaviour](#global-behaviour)
- [Commands](#commands)
  - [`run`](#ferrule-run)
  - [`validate`](#ferrule-validate)
  - [`test`](#ferrule-test)
  - [`tap`](#ferrule-tap)
  - [`top`](#ferrule-top)
  - [`fmt`](#ferrule-fmt)
  - [`repl`](#ferrule-repl)
  - [`eval`](#ferrule-eval)
  - [`list`](#ferrule-list)
  - [`describe`](#ferrule-describe)
  - [`explain`](#ferrule-explain)
  - [`generate`](#ferrule-generate)
  - [`bench`](#ferrule-bench)
  - [`lsp`](#ferrule-lsp)
- [Examples](#examples)
- [Programmatic API](#programmatic-api)
- [Known gaps](#known-gaps)

## Install / run

```sh
pnpm --filter @ferrule/cli build
node packages/cli/dist/bin.js --help
# or, once linked/installed as `ferrule`:
ferrule --help
ferrule --version
```

## Global behaviour

- **Exit codes** are consistent across every command: `0` ok, `1` runtime failure, `2` usage error
  (bad flags, unknown command), `3` configuration/validation error, `4` tests failed (`ferrule
test`; `ferrule fmt --check` uses `1`, matching a formatter's usual convention).
- **`--help`/`-h`** on any command (including the bare `ferrule --help`) prints generated usage,
  every flag with its type/default, and positionals. **`--version`** prints the package version,
  read from `package.json` at runtime — never hard-coded.
- **`--debug`** (global, every command) shows a full stack trace for unexpected errors instead of a
  short message. Expected errors (bad config, a script that doesn't compile, a component that
  isn't registered) are always rendered as a clean message with the relevant code frame; `--debug`
  only changes what an _unexpected_ failure looks like.
- **Colour** follows [`NO_COLOR`](https://no-color.org)/`FORCE_COLOR`/TTY detection, in that order:
  `NO_COLOR` (any non-empty value) always disables it, `FORCE_COLOR` (unset vs `0` vs anything
  else) overrides TTY detection either way, and otherwise colour is on exactly when stdout is a
  terminal.
- **Flags**: `--flag value`, `--flag=value`, `-f value` (short aliases), `--no-flag` for negatable
  booleans, a flag repeated to collect a list (`-c a.yaml -c b.yaml`), typed values (`integer`,
  `number`, `duration` via `@ferrule/core`'s `parseDuration`, `path`, `enum`), and `--` to stop
  flag parsing (everything after is positional even if it looks like a flag). An unknown flag or
  command gets a "did you mean" suggestion when one is close.

## Commands

### `ferrule run`

Runs a pipeline until it's told to stop.

```sh
ferrule run -c pipeline.yaml
ferrule run -c conf.d --watch --api
ferrule run -c pipeline.yaml --data-dir /var/lib/ferrule --shutdown-timeout 10s
ferrule run -c pipeline.yaml --log-level debug --log-format json
```

| Flag                                                                          | Meaning                                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-c, --config <file\|dir>` (repeatable)                                       | Config file(s) or directories (see `@ferrule/config`'s multi-file loading).                                 |
| `--secrets-dir <dir>` / `--secrets-env-prefix <prefix>`                       | `${secret:NAME}` backend (file-per-secret directory, or environment variables under a prefix). At most one. |
| `--data-dir <dir>`                                                            | Overrides `data_dir` from the config.                                                                       |
| `--no-healthchecks`                                                           | Skip sink health checks at startup.                                                                         |
| `--shutdown-timeout <duration>`                                               | Graceful shutdown deadline; overrides the config.                                                           |
| `--log-level <trace\|debug\|info\|warn\|error>` / `--log-format <text\|json>` | Overrides `log.level`/`log.format` from the config.                                                         |
| `--api`                                                                       | Start the admin API even if the config disables it.                                                         |
| `--api-address <host:port>` / `--api-token <token>`                           | Admin API bind address and bearer token (token also read from `$FERRULE_API_TOKEN`).                        |
| `--watch`                                                                     | Reload automatically when a config file's mtime changes (poll-based, debounced).                            |

Builds the default registry (every builtin source/operator/sink), loads and validates the config,
converts it to a topology with the overrides above, creates the pipeline with a crash-safe disk
buffer factory (`@ferrule/runtime`'s `createDiskBufferFactory`), and starts it. A config or
topology error is rendered as a code frame and exits `3` without starting anything.

**Signals:**

- `SIGINT`/`SIGTERM` — graceful stop (`pipeline.stop()`). A **second** `SIGINT`/`SIGTERM` while a
  stop is already in progress skips waiting for it and forces an immediate exit (code `1`).
- `SIGHUP` — reloads: re-reads the same config paths, diffs the result against what's running
  (`@ferrule/config`'s `diffConfigs`), calls `pipeline.reload(...)`, and logs which components were
  added/removed/changed. An invalid reload (bad config or topology) is logged as an error and the
  **running pipeline keeps going**, exactly like a real operator would want.
- `--watch` drives the same reload path automatically on a config file change (polling each
  resolved file's mtime, debounced so a burst of edits triggers one reload, not several).

### `ferrule validate`

Validates a config — schema, topology graph, and every component's `build()` (including script
compilation) — without starting anything.

```sh
ferrule validate -c pipeline.yaml
ferrule validate -c conf.d --no-environment
ferrule validate -c pipeline.yaml --json
```

`--no-environment` skips checks that touch the filesystem (a `file` source's data directory,
`file`-buffer checkpoints): `data_dir` is treated as unset for this run, so a component that
requires one (and only exists to touch the environment) reports that plainly instead of the
directory actually being created. `--json` prints diagnostics/warnings/components as machine-
readable JSON instead of code frames. Exit `3` on any error; warnings (e.g. an unused source) are
printed but don't fail the run.

### `ferrule test`

Runs pipeline test files (YAML, `@ferrule/testkit`'s format — see its README for the full
reference) and, for every `type: script` transform their config references, that script's inline
`test { ... }` blocks — combined into one report.

```sh
ferrule test                                  # scans the current directory for *.test.yaml
ferrule test pipeline_tests/
ferrule test app.test.yaml other.test.yaml
ferrule test --reporter junit --output report.xml
```

A bare positional is used as given if it's a file (regardless of name); a directory is scanned
recursively for `*.test.yaml`/`*.test.yml`. `--reporter human|junit|json` (default `human`);
`--output <file>` writes the report to a file instead of stdout. Exit `4` if any case failed, `3`
if a test file itself is malformed (rendered as a code frame) or its pipeline config doesn't
build.

### `ferrule tap`

Streams clones of the events flowing through one component's output, from a running instance's
admin API (`@ferrule/admin`'s `AdminClient.tap`).

```sh
ferrule tap app_logs --api-address 127.0.0.1:9090
ferrule tap shape --port errors --sample 0.1 --limit 100 --format ndjson
```

`--port <name>` taps a named output port instead of the default one; `--sample <rate>` (0, 1] and
`--limit <n>` are passed straight through to the admin API's own sampling/limit. `--format
ndjson|pretty` (default `pretty`, indented JSON) controls how each event is printed. `--token
<token>` or `$FERRULE_API_TOKEN` authenticates against a token-protected admin API.

### `ferrule top`

A refreshing terminal table of a running instance's components: state, events in/out per second
(computed from `component_received_events_total`/`component_sent_events_total` counter deltas
between polls), errors, and buffer depth, polled from `/health` and `/metrics`.

```sh
ferrule top --api-address 127.0.0.1:9090
ferrule top --once
ferrule top --interval 500ms
```

`--once` prints a single snapshot and exits (no rates on the first poll, since a rate needs two
samples). When stdout isn't a TTY, the screen isn't cleared between refreshes — each snapshot is
just printed after the last, so piping `ferrule top` to a file or `less` still produces something
readable instead of a stream of cursor-control escape codes.

### `ferrule fmt`

Formats `.fe` Ferrule Script files with `@ferrule/script`'s canonical formatter (idempotent,
comment-preserving where the grammar has somewhere to attach them).

```sh
ferrule fmt transforms/*.fe
ferrule fmt --check .                # report only; exit 1 if anything would change
echo '.a=1' | ferrule fmt --stdin    # format from stdin to stdout
```

### `ferrule repl`

An interactive Ferrule Script REPL, reading lines from stdin (an injectable stream — see
`CliEnvironment` below — so it never depends on the real `process.stdin`).

```
$ ferrule repl
ferrule repl — type :help for commands, :quit to exit.
> :event {"status": 200}
{ "status": 200.0 }
> .ok = .status < 300
=> true
event: { "status": 200, "ok": true }
> :type .status
int
> :quit
```

A single bare expression (`1 + 2`, `.status < 300`, ...) is evaluated and its value shown with
`=> ...` (via `@ferrule/core`'s `formatValue`); any other input (assignments, `if`, `let`, ...) is
run as a statement against the current event, whose new state is always shown afterward. Input
spanning multiple lines is supported automatically: as long as brackets/quotes are unbalanced, the
REPL keeps reading before evaluating. Diagnostics (a syntax or type error) are rendered inline,
exactly like `ferrule eval`/`ferrule test`, and don't end the session.

Commands: `:event {json}` sets the current event's fields; `:load file.json` loads them from a
file; `:type <expr>` shows an expression's static type without running it; `:reset` clears the
event back to `{}`; `:help`; `:quit`/`:exit`.

### `ferrule eval`

A one-shot scripting tool: runs a program over NDJSON input, one event per line, and writes the
resulting event(s) as NDJSON.

```sh
ferrule eval -e '.upper = upcase(.message) ?? .message' --input events.ndjson
echo '{"message":"hi"}' | ferrule eval -e 'del(.debug)'
ferrule eval -f redact.fe < events.ndjson > redacted.ndjson
```

`-e/--program` (inline source) or `-f/--file` (a `.fe` file); `-i/--input` (default stdin). A
dropped event produces no output line; an aborted event's reason is printed to stderr (and the
command exits `3` if any event aborted) without stopping the rest of the input. A line that isn't
valid JSON is skipped with a warning rather than ending the run.

### `ferrule list`

Lists every registered source, transform, and sink type with its one-line description.

```sh
ferrule list
ferrule list sinks
ferrule list sources --json
```

### `ferrule describe`

Prints a component type's option schema as a readable tree — type, default, `[secret]`/`[optional]`
markers, constraints, and examples — from its `Schema.toDoc()`.

```sh
ferrule describe clickhouse
ferrule describe demo_logs --json
```

### `ferrule explain`

Explains a diagnostic code: Ferrule Script's own catalog (`@ferrule/script`'s `explainCode`, codes
like `E301`) first, then a local catalog of topology-graph codes (`E_CYCLE`, `E_UNKNOWN_INPUT`, ...)
and generic schema/config issue codes (`invalid_type`, `unknown_key`, ...).

```sh
ferrule explain E301
ferrule explain E_CYCLE
ferrule explain --list
```

### `ferrule generate`

Scaffolds a starter config from a chain of component types — source first, sink last, any
transforms in between — with every _required_ option stubbed from that type's schema.

```sh
ferrule generate demo_logs/console
ferrule generate demo_logs remap_fields console      # same chain, space-separated
ferrule generate demo_logs/console --output pipeline.yaml
```

The stub values are placeholders (`"CHANGE_ME"`, a schema's minimum, the first enum value, ...),
meant to be edited, not run as-is — but the _shape_ is always valid: a freshly generated config,
with its placeholders replaced, passes `ferrule validate`.

### `ferrule bench`

An in-process benchmark pipeline (`demo_logs` → optional `script` transform → `blackhole`), run for
a fixed duration, reporting throughput and latency percentiles (measured via `pipeline.tap()` on
the stage feeding the sink, since `blackhole` itself has nothing to inspect).

```sh
ferrule bench
ferrule bench --duration 10s --events-per-second 5000
ferrule bench --script transforms/shape.fe
```

`demo_logs` paces itself in one batch per configured second rather than a smooth stream, so a very
high `--events-per-second` mostly measures how long that one batch takes to drain (a real, if
bursty, characteristic — not a bug) rather than steady-state per-event latency; lower it for a
smoother measurement.

### `ferrule lsp`

Starts the Ferrule Script language server (`@ferrule/lsp`'s `startLanguageServer`) on stdio, for
an editor to talk to over JSON-RPC. `SIGINT`/`SIGTERM` disposes the server and exits cleanly even
without a client-initiated `shutdown`/`exit` sequence.

```sh
ferrule lsp
```

## Examples

`examples/` has runnable pipeline configs covering a range of the sources/transforms/sinks this
milestone ships with; each one is validated by `packages/cli/test/examples.test.ts`
(`ferrule validate` against every file, in a temp `--data-dir`):

| File                             | Shape                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `demo_to_console.yaml`           | `demo_logs` → `console` — the smallest possible pipeline.                                                |
| `nginx_to_clickhouse.yaml`       | `file` (tailing an nginx access log) → `script` (regex-parses it into structured fields) → `clickhouse`. |
| `otlp_traces_tail_sampling.yaml` | `otlp` (traces) → `tail_sampling` (errors, slow spans, and a probabilistic sample) → `otlp`.             |
| `statsd_to_prometheus.yaml`      | `statsd` → `aggregate` (10s rollup) → `prometheus_exporter`.                                             |
| `file_redact_to_loki.yaml`       | `file` → `script` (strips sensitive fields) → `loki`, behind a disk buffer.                              |
| `route_by_severity.yaml`         | `demo_logs` → `filter` (drop debug) → `route` (named ports per severity) → three sinks.                  |

## Programmatic API

`packages/cli/src/index.ts` exports the pieces above `bin.ts`, for embedding or testing without a
subprocess:

```ts
import { runCli, createNodeEnvironment } from '@ferrule/cli';

const exitCode = await runCli(createNodeEnvironment({ argv: ['validate', '-c', 'pipeline.yaml'] }));
```

`CliEnvironment` is the seam every command runs against: `argv`, `env`, `cwd`, `stdin`/`stdout`/
`stderr` (a minimal `CliReadable`/`CliWritable`, not necessarily real Node streams — except for
`ferrule lsp`, which needs full `NodeJS.ReadableStream`/`WritableStream` since it hands them
straight to `@ferrule/lsp`'s JSON-RPC framing), a `Clock` (`@ferrule/runtime`'s interface — tests
use `ManualClock`, `run`'s and `bench`'s and `top`'s end-to-end tests use the real one since they
drive real timers other packages own), an injectable `SignalSource` (`SIGINT`/`SIGTERM`/`SIGHUP`),
and `hardExit` (what a second termination signal calls — `process.exit` for real, a recording fake
in tests). `createNodeEnvironment()` builds the real one; `packages/cli/test/support/environment.ts`
builds the fake one every test in this package uses.

## Known gaps

- `ferrule generate`'s stubs cover _required_ fields only; optional fields with interesting
  defaults (auth, TLS, batching) aren't shown — run `ferrule describe <type>` alongside it for the
  full picture.
- `ferrule top`'s rates need two polls; a single `--once` snapshot always shows `-` for in/s and
  out/s.
- `ferrule bench` only benchmarks the shape `demo_logs → [script] → blackhole`; there's no way to
  point it at an arbitrary config's sources/sinks (deliberately — pointing a load generator at a
  real network sink is rarely what "benchmark this pipeline" means, and `demo_logs`'s determinism
  keeps runs comparable).
- Console/file/socket/syslog sinks write to the real `process.stdout`/`process.stderr`/filesystem
  regardless of `CliEnvironment` (that's `@ferrule/sinks`' own design, not this package's) — so
  `ferrule run`'s own tests assert delivery through the admin API's metrics rather than by
  scraping a captured stdout for event payloads, and running two `console`-sink pipelines
  concurrently in one process (as this package's own test suite does) means their output
  interleaves on the real terminal.
