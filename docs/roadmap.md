# Roadmap

Ferrule was built in milestones, each ending with its packages documented, tested, and passing
the full local check (`pnpm run check`). This page records what each milestone delivered and
what comes next.

## Delivered

| #   | Milestone                  | Packages                | Highlights                                                                                                  |
| --- | -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| M0  | Foundation & data model    | `core`, `schema`        | Integer/float-distinct values, nanosecond timestamps, lossless JSON, acknowledgements, typed option schemas |
| M1  | Language front end         | `script`                | Error-recovering parser, type checker with fallibility and flow narrowing, diagnostics, formatter           |
| M2  | Language back end & stdlib | `script`                | Closure compiler, optimizer, resource limits, inline tests, ~95 standard library functions                  |
| M3  | Codecs                     | `codecs`                | Streaming framers, protobuf/OTLP, syslog, logfmt, CSV, Prometheus text, StatsD, pattern engine              |
| M4  | Runtime & disk buffer      | `runtime`, `buffer`     | Bounded channels, hot reload, tap, sink toolkit, crash-safe segmented WAL with fault-injection tests        |
| M5  | Operators                  | `operators`             | 15 transforms incl. script, route, aggregate, tail sampling, cardinality limiting                           |
| M6  | Sources & sinks            | `sources`, `sinks`      | 10 sources, 15 sinks incl. hand-written Postgres, Kafka, SigV4, and Snappy implementations                  |
| M7  | Config & control plane     | `config`, `admin`       | Position-aware YAML parser, secrets, code-frame diagnostics, admin API with live tap                        |
| M8  | CLI, testkit & LSP         | `cli`, `testkit`, `lsp` | `ferrule` command, pipeline test runner with JUnit output, language server                                  |

## Next

Planned work, roughly in priority order:

- **Worker-thread transforms.** An asynchronous transform contract and a `worker_threads` pool
  for CPU-heavy scripts, reusing the binary event encoding from `@ferrule/buffer`.
- **Script on metrics and spans.** The compiler currently runs on log events only; metrics and
  spans pass through `script` unchanged.
- **Kafka source** (consumer groups, offset commits driven by acknowledgements).
- **Exponential histograms end to end.** Decoding is supported; encoding always produces
  explicit-bucket histograms.
- **Idempotent Kafka producer** to avoid duplicates on partial batch retries.
