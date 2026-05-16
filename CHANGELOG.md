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
  inline tests, and a standard library of about 95 functions.
- `@ferrule/codecs`: streaming framers, protobuf and OTLP (protobuf and JSON), syslog, logfmt,
  CSV, Prometheus text, StatsD, and a typed pattern engine.
- `@ferrule/buffer`: crash-safe segmented write-ahead disk buffer with fault-injection tests, and
  a compact binary event encoding.
- `@ferrule/runtime`: bounded channels, topology validation, graceful shutdown, hot reload, live
  tap, internal metrics, and a sink toolkit (batching, retries, circuit breaking, adaptive
  concurrency).
- `@ferrule/operators`: 15 transforms, including `script`, `route`, `aggregate`,
  `tail_sampling`, and `cardinality_limit`.
- `@ferrule/sources`: 10 sources, including HTTP, OTLP, syslog, file tailing with checkpoints,
  StatsD, and Prometheus scraping.
- `@ferrule/sinks`: 15 sinks, including Loki, ClickHouse, Elasticsearch, S3-compatible storage,
  OTLP, Prometheus, Kafka, and PostgreSQL.
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
