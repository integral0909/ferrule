# Roadmap

Ferrule is built in milestones. Each milestone ends with its packages documented, tested, and
passing CI on all supported platforms. The rough sizes are planning estimates, not targets to
pad toward.

| #   | Milestone                  | Packages                      | Est. production LOC | Est. test LOC |
| --- | -------------------------- | ----------------------------- | ------------------- | ------------- |
| M0  | Foundation & data model    | `core`                        | 3–4k                | 2–3k          |
| M1  | Language front end         | `script` (lexer → checker)    | 10–12k              | 6–8k          |
| M2  | Language back end & stdlib | `script` (compiler, ~150 fns) | 10–13k              | 7–9k          |
| M3  | Codecs                     | `codecs`                      | 8–10k               | 5–6k          |
| M4  | Runtime & disk buffer      | `runtime`, `buffer`           | 7–9k                | 5–6k          |
| M5  | Operators                  | `operators`                   | 5–7k                | 3–4k          |
| M6  | Sources & sinks            | `sources`, `sinks`            | 8–10k               | 4–5k          |
| M7  | Config & control plane     | `config`, `admin`             | 4–5k                | 2–3k          |
| M8  | CLI, testkit & LSP         | `cli`, `testkit`, `lsp`       | 5–7k                | 2–3k          |

Total: roughly 60–77k production and 36–47k test LOC, plus documentation.

## M0 — Foundation & data model

- [x] Monorepo tooling, CI, security policy
- [x] Value model (integer/float distinction, bytes, timestamps, ordered objects)
- [x] Nanosecond timestamps with RFC 3339 parsing/formatting
- [x] Duration and byte-size parsing
- [x] Field paths: parse, format, get/set/delete
- [x] Lossless, bounded JSON codec
- [x] Log, metric, and span events
- [x] Metric value arithmetic (merge incremental, absolute → incremental)
- [x] End-to-end acknowledgements (batch notifiers, finalizers)

## M1 — Language front end

- Lexer with raw strings, byte strings, timestamp and regex literals, and precise spans
- Pratt parser with error recovery (multiple diagnostics per run)
- Resolver: variables, scopes, field paths, function signatures
- Type checker: kinds, unions, object shapes, fallibility tracking, flow narrowing
- Diagnostics with codes, labels, notes, and fix suggestions; terminal renderer
- Formatter (round-trip stable)

## M2 — Language back end & standard library

- Constant folding, dead-branch elimination, path access specialisation
- Closure compiler with typed operation selection
- Standard library: strings, numbers, timestamps, parsing (JSON, logfmt, key-value, regex,
  syslog, CSV, URL, user agent), encoding, hashing, IP and CIDR, redaction, arrays/objects,
  type coercion
- Script test runner (inline `test` blocks)

## M3 — Codecs

- Protobuf wire format reader/writer; OTLP logs/metrics/traces mapping
- Syslog RFC 3164 / 5424, logfmt, Prometheus text exposition, StatsD, CSV
- Framing: newline, length-prefixed, octet-counting, chunked
- Pattern library for common log formats

## M4 — Runtime & disk buffer

- Bounded channels (count and byte limits), fan-out with lazy cloning
- Topology builder, lifecycle, graceful shutdown with drain deadlines
- Retry with jittered backoff, circuit breakers, dead-letter routing
- Segmented WAL disk buffer with crash recovery; fault-injection tests
- Worker-thread transform pool

## M5 — Operators

- Route, filter, sample, dedup, throttle
- Windowed aggregation (tumbling, sliding, session)
- Metric cardinality limiter, log-to-metric
- Tail-based trace sampling with policies and memory caps

## M6 — Sources & sinks

- Sources: HTTP, OTLP/HTTP, syslog TCP/UDP, file tail with checkpoints, StatsD, internal metrics
- Sinks: HTTP/webhook, console, file, S3-compatible object storage, ClickHouse, Postgres,
  Loki-compatible push, Kafka-protocol producer

## M7 — Config & control plane

- YAML subset parser, env and secret interpolation, schema validation with source positions
- Topology diffing for hot reload
- Admin API: health, topology, metrics, tap

## M8 — CLI, testkit & LSP

- `ferrule run | validate | test | tap | fmt | repl | bench`
- `@ferrule/testkit` for component authors
- Language server
