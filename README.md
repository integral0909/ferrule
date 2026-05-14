# Ferrule

Ferrule is a telemetry pipeline for logs, metrics, and traces. It receives events from many
sources, reshapes them with **Ferrule Script** — a small, statically typed transform language —
and delivers them to storage and analysis backends with backpressure and at-least-once delivery.

> **Status:** pre-1.0. Every planned milestone has landed (see [docs/roadmap.md](docs/roadmap.md)),
> but configuration keys and APIs may still change before a 1.0 release.

## Why Ferrule

- **Transforms that fail at load time, not at 3 a.m.** Ferrule Script is type-checked when a
  pipeline is loaded. Operations that can fail at runtime (parsing, coercion) must be handled
  explicitly, so an unexpected input never silently drops or corrupts an event.
- **Delivery you can reason about.** Every edge in a pipeline is bounded. Backpressure propagates
  to sources, and an optional disk buffer gives crash-safe, at-least-once delivery with
  end-to-end acknowledgements.
- **Cost control built in.** Tail-based trace sampling, metric cardinality limits, log-to-metric
  conversion, and field redaction are first-class operators, not afterthoughts.
- **Extensible in TypeScript.** Custom sources, sinks, and operators are ordinary TypeScript
  modules implementing small, documented interfaces.

## A taste of Ferrule Script

```ferrule
# Parse an nginx access line, drop health checks, redact client IPs.
let parsed = parse_regex(.message, r/^(?<ip>\S+) \S+ \S+ \[[^\]]+\] "(?<method>\S+) (?<path>\S+)[^"]*" (?<status>\d+)/) ?? abort

if parsed.path == "/healthz" { drop }

.http.method = parsed.method
.http.path   = parsed.path
.http.status = to_int(parsed.status) ?? 0
.client_ip   = redact_ip(parsed.ip, keep_prefix: 24) ?? "0.0.0.0"
```

The language design is described in [docs/language/design.md](docs/language/design.md).

## Quick start

Requirements: Node.js 22.12+ and pnpm 10.

```sh
pnpm install && pnpm run build
node packages/cli/dist/bin.js run -c packages/cli/examples/demo_to_console.yaml
```

A pipeline is a YAML file of sources, transforms, and sinks:

```yaml
data_dir: ./data

sources:
  app_logs:
    type: file
    include: ['/var/log/myapp/*.log']
    decoding: { codec: json }

transforms:
  redact:
    type: script
    inputs: [app_logs]
    source: |
      del(.user.email)
      .message = redact(.message, [r/\b\d{3}-\d{2}-\d{4}\b/]) ?? .message

sinks:
  loki_out:
    type: loki
    inputs: [redact]
    url: https://loki.internal:3100
    labels: { service: '{service}' }
    buffer: { type: disk, max_size: 2GiB }
```

More complete examples live in [packages/cli/examples](packages/cli/examples).

## What's included

- **Sources:** HTTP, OTLP/HTTP, syslog (TCP, TLS, UDP), file tailing with checkpoints, StatsD,
  Prometheus scraping, stdin, internal metrics, heartbeat, and a demo log generator.
- **Transforms:** `script`, `filter`, `route`, `remap_fields`, `sample`, `throttle`, `dedupe`,
  `aggregate`, `log_to_metric`, `metric_to_log`, `cardinality_limit`, `window_reduce`,
  `tail_sampling`, `split_by_kind`, and `metric_tags`.
- **Sinks:** HTTP, Loki, ClickHouse, Elasticsearch, S3-compatible object storage, OTLP,
  Prometheus remote write and exporter, Kafka, PostgreSQL, file, socket, syslog, console, and
  blackhole. The Kafka, PostgreSQL, SigV4, and Snappy protocol code is implemented in the repo,
  with no third-party runtime dependencies.
- **Tooling:** the `ferrule` CLI (`run`, `validate`, `test`, `tap`, `top`, `fmt`, `repl`, `eval`,
  `describe`, `generate`, `bench`, ...), a pipeline test runner with JUnit output, an admin API
  with a live event tap, and a language server for editor support.

Every component's options are listed in the generated
[component reference](docs/reference/components.md).

## Documentation

- [Architecture](docs/architecture.md): data model, runtime, delivery guarantees
- [Ferrule Script design](docs/language/design.md) and the
  [script package reference](packages/script/README.md) (standard library, limits)
- [Configuration](packages/config/README.md) and the [CLI](packages/cli/README.md)
- [Testing pipelines](packages/testkit/README.md) and the [admin API](packages/admin/README.md)
- [Editor setup](packages/lsp/README.md)

## Repository layout

| Package     | Contents                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| `core`      | Values, events, timestamps, field paths, lossless JSON, acknowledgements  |
| `schema`    | Typed option schemas with path-aware validation and secret redaction      |
| `script`    | Ferrule Script: parser, type checker, compiler, standard library          |
| `codecs`    | Framing and wire formats: protobuf/OTLP, syslog, logfmt, CSV, Prometheus  |
| `buffer`    | Crash-safe segmented write-ahead disk buffer and binary event encoding    |
| `runtime`   | Channels, topology, lifecycle, hot reload, tap, sink toolkit              |
| `operators` | Built-in transforms                                                       |
| `sources`   | Built-in sources                                                          |
| `sinks`     | Built-in sinks                                                            |
| `config`    | YAML/JSON loading, interpolation, secrets, diagnostics, topology bridging |
| `admin`     | Admin HTTP API and client                                                 |
| `testkit`   | Pipeline test runner, reporters, and component harnesses                  |
| `lsp`       | Language server for Ferrule Script                                        |
| `cli`       | The `ferrule` command                                                     |

## Development

```sh
pnpm install
pnpm run check      # format, lint, typecheck, test
pnpm run docs:check # generated component reference is up to date
pnpm run build      # compile all packages to dist/
pnpm run test:watch # iterate on tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

Apache-2.0
