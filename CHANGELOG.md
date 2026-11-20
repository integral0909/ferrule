# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Added

- `@ferrule/core`: value model with distinct integer and float kinds, nanosecond timestamps,
  field paths, a lossless bounded JSON codec, log/metric/span events, metric arithmetic, and
  end-to-end delivery acknowledgements.
- `@ferrule/schema`: typed option schemas that report every issue with its path, suggest fixes
  for typos, and redact secrets.
- `@ferrule/script`: Ferrule Script — parser with error recovery, type checker with fallibility
  tracking and flow narrowing, closure compiler with an optimizer and per-event resource limits,
  inline tests, and a standard library of about 95 functions. A program targets either log or
  metric events (`target`); a metric's fixed shape (`.name`, `.tags`, `.value`, …) is fully typed,
  so unknown fields, wrongly typed writes (`.tags.env = 1`), and writes to the read-only `.type`
  are all reported at compile time.
- `@ferrule/codecs`: streaming framers, protobuf and OTLP (protobuf and JSON), syslog, logfmt,
  CSV, Prometheus text, StatsD, and a typed pattern engine.
- `@ferrule/buffer`: crash-safe segmented write-ahead disk buffer with fault-injection tests, and
  a compact binary event encoding.
- `@ferrule/runtime`: bounded channels, topology validation, graceful shutdown, hot reload, live
  tap, internal metrics, and a sink toolkit (batching, retries, circuit breaking, adaptive
  concurrency).
- `@ferrule/operators`: 15 transforms, including `script` (over log or metric events, selected by
  `event_kind`), `route`, `aggregate`, `tail_sampling`, and `cardinality_limit`.
- `@ferrule/sources`: 10 sources, including HTTP, OTLP, syslog, file tailing with checkpoints,
  StatsD, and Prometheus scraping.
- `@ferrule/sinks`: 15 sinks, including Loki, ClickHouse, Elasticsearch, S3-compatible storage,
  OTLP, Prometheus, Kafka, and PostgreSQL. The Kafka sink is an idempotent producer by default
  (`idempotent: true`, requires `acks: "-1"`): a producer id and per-partition sequence numbers
  let the broker discard a batch resent after a partial failure or a lost response, so retries
  never duplicate records (#17).
- `@ferrule/sinks`: zstd compression for the Kafka sink and the HTTP-family sinks via `node:zlib`
  (`compression: zstd`, with `zstd_level` 1–22, default 3), and `.zst` object keys in
  `object_storage`. Decompression is bounded and detects truncated frames, which `node:zlib`
  itself silently accepts. Kafka's batch decoder now also bounds gzip output. LZ4 was dropped
  from scope (#16).
- Exponential histograms end to end (#9). `@ferrule/core` has an `exponential_histogram` metric
  value (scale, zero count and threshold, positive/negative bucket offsets and counts) whose
  `addMetricValues`/`subtractMetricValues` merge points at different scales by downscaling,
  capped at 160 buckets per range. The OTLP codecs decode `ExponentialHistogram` losslessly in
  protobuf and JSON (JSON previously dropped it) and encode it natively. Prometheus text, remote
  write, and the exporter convert to classic buckets with `exponentialToExplicitHistogram`, only
  after merging. `@ferrule/buffer` stores it as metric tag 6. Ferrule Script reads `.scale`
  (read-only) and reads/writes `.count` and `.sum`.
- `@ferrule/config`: position-aware YAML parser, interpolation, secret backends, code-frame
  diagnostics, and config diffing.
- `@ferrule/admin`: admin HTTP API with health, topology, metrics, live tap, and reload.
- `@ferrule/testkit`: pipeline test runner with human, JUnit, and JSON reports, and component
  harnesses.
- `@ferrule/lsp`: language server for Ferrule Script.
- `@ferrule/cli`: the `ferrule` command with `run`, `validate`, `test`, `tap`, `top`, `fmt`,
  `repl`, `eval`, `list`, `describe`, `explain`, `generate`, `bench`, and `lsp`.
- Generated component reference (`docs/reference/components.md`), CI on Linux, macOS, and
  Windows, CodeQL, dependency review, and Dependabot.

### Fixed

- OTLP metric encoding (protobuf and JSON) put delta and cumulative histograms of the same name
  into one `Metric`, so every point took the first point's temporality. Points are now grouped by
  kind for every shape except `summary`, which has no temporality.
- Converting an exponential histogram to explicit buckets computed boundaries as `base^i`, which
  rounds twice: at scale 1 the boundary 2 came out as `2.0000000000000004`, so Prometheus `le`
  labels for the same boundary differed between scales. Boundaries are now `2^(i·2^-scale)`,
  exact at every power of two.
- `prometheus_exporter` and `prometheus_remote_write` reject an exponential histogram point whose
  explicit bucket boundaries would overflow a double (only at very low scales). The exporter
  previously would have thrown on every scrape, and remote write failed the whole batch.

### Changed

- Node.js 22.15.0 or newer is now required (was 22.12.0): it is the first 22.x with zstd in
  `node:zlib`. CI tests that exact version alongside the latest 22 and 24.
