# Ferrule

Ferrule is a telemetry pipeline for logs, metrics, and traces. It receives events from many
sources, reshapes them with **Ferrule Script** — a small, statically typed transform language —
and delivers them to storage and analysis backends with backpressure and at-least-once delivery.

> **Status:** early development. The core data model is in place; the language toolchain,
> runtime, and connectors are being built out milestone by milestone (see
> [docs/roadmap.md](docs/roadmap.md)). Nothing here is stable yet.

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
let parsed = parse_regex(.message, r'^(?<ip>\S+) \S+ \S+ \[[^\]]+\] "(?<method>\S+) (?<path>\S+)[^"]*" (?<status>\d+)') ?? abort

if parsed.path == "/healthz" { drop }

.http.method = parsed.method
.http.path   = parsed.path
.http.status = to_int(parsed.status) ?? 0
.client_ip   = redact_ip(parsed.ip, keep_prefix: 24)
```

The language design is described in [docs/language/design.md](docs/language/design.md).

## Repository layout

| Path            | Contents                                                               |
| --------------- | ---------------------------------------------------------------------- |
| `packages/core` | Event data model, values, timestamps, field paths, lossless JSON, acks |
| `docs/`         | Architecture, roadmap, and language design                             |

Further packages (`script`, `codecs`, `runtime`, `buffer`, `operators`, `sources`, `sinks`,
`config`, `admin`, `cli`, `lsp`, `testkit`) are added as their milestones land. See
[docs/architecture.md](docs/architecture.md) for how they fit together.

## Development

Requirements: Node.js 22.12+ and pnpm 10.

```sh
pnpm install
pnpm run check      # format, lint, typecheck, test
pnpm run build      # compile all packages to dist/
pnpm run test:watch # iterate on tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

Apache-2.0 © Fredrik Ahman
