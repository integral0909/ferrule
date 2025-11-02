# `@ferrule/admin`

An embeddable admin HTTP server for a running `@ferrule/runtime` `Pipeline`: health, live
topology, internal metrics, per-component detail, a live event tap, a redacted config dump, and
hot reload — plus a small typed client for consuming all of it. This package implements the
[architecture doc's](../../docs/architecture.md) §7 "Observability of Ferrule itself" and the M7
roadmap item's admin API half. It is built entirely on `node:http`: no third-party dependencies.

## Contents

- [Quick start](#quick-start)
- [Server options](#server-options)
- [Endpoint reference](#endpoint-reference)
- [Security](#security)
- [The client](#the-client)

## Quick start

```ts
import { createAdminServer } from '@ferrule/admin';
import { MetricsRegistry, Pipeline } from '@ferrule/runtime';

const metrics = new MetricsRegistry();
const pipeline = await Pipeline.create(topologySpec, { registry, metrics });
await pipeline.start();

const admin = createAdminServer({
  pipeline,
  metrics,
  address: { host: '127.0.0.1', port: 9090 },
  auth: { token: process.env['FERRULE_ADMIN_TOKEN']! },
  onReload: () => pipeline.reload(await loadConfig()),
  configDump: () => renderRedactedConfig(currentSpec),
});
const bound = await admin.start();
console.log(`admin API listening on http://${bound.host}:${bound.port}`);

// later, during graceful shutdown:
await admin.stop();
await pipeline.stop();
```

## Server options

`createAdminServer(options: AdminServerOptions): AdminServer`

| Option             | Type                                                         | Default                          | Notes                                                                 |
| ------------------ | ------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------- |
| `pipeline`         | `Pipeline`                                                   | required                         | Backs `/health`, `/topology`, `/components/:id`, `/tap/:component`.   |
| `metrics`          | `MetricsRegistry`                                            | required                         | Backs `/metrics` and the metrics subset in `/components/:id`.         |
| `address`          | `{ host?, port? }`                                           | `127.0.0.1`, ephemeral port `0`  | Binds loopback only unless you explicitly widen it.                   |
| `auth`             | `{ token, requireForAll? }`                                  | none                             | Bearer token; see [Security](#security).                              |
| `onReload`         | `() => ReloadResult \| Promise<ReloadResult>`                | none (`/reload` returns 404)     | Supplied by the CLI; performs the reload and reports the result.      |
| `configDump`       | `() => string \| Promise<string>`                            | none (`/config` returns 404)     | Supplied by the CLI; must already be redacted.                        |
| `logger` / `clock` | `Logger` / `Clock`                                           | a null logger / the system clock | Same interfaces as the rest of the runtime.                           |
| `allowedHosts`     | `readonly string[]`                                          | `[]`                             | Extra `Host` values accepted by the DNS-rebinding guard.              |
| `maxBodyBytes`     | `number`                                                     | `1048576` (1 MiB)                | Request body cap; exceeding it returns 413 and closes the connection. |
| `requestTimeoutMs` | `number`                                                     | `30000`                          | Non-streaming requests only; `/tap` is exempt.                        |
| `tap`              | `{ heartbeatIntervalMs?, defaultQueueCapacity?, maxLimit? }` | see below                        | Tunes `/tap` behavior; see that endpoint's entry below.               |

`AdminServer`:

- `start(): Promise<BoundAddress>` — starts listening; resolves to the address actually bound
  (useful with `port: 0`).
- `stop(): Promise<void>` — stops accepting connections, closes every open `/tap` stream, and
  waits for in-flight requests. Idempotent.
- `address: BoundAddress | undefined` — set once `start()` resolves, cleared by `stop()`.
- `activeTapCount(): number` — number of currently open `/tap` subscriptions.

## Endpoint reference

Every JSON response sets `Content-Type: application/json; charset=utf-8`,
`X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`. Every error response is
`{ "error": { "code": "E_...", "message": "..." } }` with a matching HTTP status; responses never
include a stack trace.

### `GET /health`

The full health snapshot. 200 when `overall` is `running`; 503 for every other state (`starting`,
`degraded`, `stopping`, `stopped`, `failed`).

```json
{
  "overall": "running",
  "components": [
    { "id": "app_logs", "kind": "source", "type": "http", "state": "running" },
    { "id": "store", "kind": "sink", "type": "clickhouse", "state": "failed", "error": "..." }
  ]
}
```

### `GET /health/live` / `GET /health/ready`

For orchestrators. `/health/live` is 200 unless the pipeline has reached the unrecoverable
`failed` state (`{"status":"ok"}` / `{"status":"failed"}`); `/health/ready` is 200 only when
`overall` is `running` (`{"status":"ready","overall":"running"}` / `{"status":"not_ready", ...}`).

### `GET /topology`

The running graph: components, kinds, types, resolved inputs. `?format=dot` renders it as
Graphviz (`text/vnd.graphviz`); `?format=mermaid` renders it as a Mermaid flowchart (`text/plain`).
Both renderings color and label each node with its current state.

```json
{
  "components": [
    { "id": "app_logs", "kind": "source", "type": "http", "inputs": [] },
    { "id": "shape", "kind": "transform", "type": "script", "inputs": ["app_logs"] },
    { "id": "store", "kind": "sink", "type": "clickhouse", "inputs": ["shape"] }
  ]
}
```

```
$ curl 'http://127.0.0.1:9090/topology?format=dot'
digraph pipeline {
  rankdir=LR;
  ...
  "app_logs" -> "shape";
  "shape" -> "store";
}
```

### `GET /metrics`

Ferrule's own internal metrics, in Prometheus text exposition format by default (what a Prometheus
scrape config expects). `?format=json`, or a request with `Accept: application/json` (and no
`text/plain`), gets a JSON array instead:

```json
[
  {
    "name": "component_received_events_total",
    "tags": { "component_id": "app_logs", "component_kind": "source", "component_type": "http" },
    "kind": "absolute",
    "value": { "type": "counter", "value": 4213 }
  }
]
```

### `GET /components/:id`

One component's health plus the metrics recorded under its identity. 404 if no such component
exists in the current topology.

```json
{ "id": "app_logs", "kind": "source", "type": "http", "state": "running", "metrics": [ ... ] }
```

### `GET /tap/:component`

Streams clones of events flowing through a component's output port as they happen — the same
mechanism behind `ferrule tap`. Never affects the pipeline: delivery to a slow client is bounded by
dropping the subscriber's _oldest_ queued event (counted, not fatal) rather than either blocking
the pipeline or growing the server's own write buffer without limit.

Query parameters:

| Param    | Meaning                                                            | Default                                              |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `port`   | Output port to tap                                                 | the component's default port                         |
| `sample` | Sampling rate in `(0, 1]`                                          | `1` (every event)                                    |
| `limit`  | Stop after this many events                                        | unbounded (capped by `tap.maxLimit`, default 100000) |
| `format` | `ndjson` (one JSON object per line) or `sse` (`text/event-stream`) | `ndjson`                                             |

The stream also ends the moment the client disconnects. For `format=sse`, a `: heartbeat` comment
is written every `tap.heartbeatIntervalMs` (default 15000) so intermediaries don't time the
connection out.

```
$ curl -N 'http://127.0.0.1:9090/tap/app_logs?sample=0.1&limit=3'
{"kind":"log","metadata":{...},"fields":{"message":"hello"}}
{"kind":"log","metadata":{...},"fields":{"message":"world"}}
{"kind":"log","metadata":{...},"fields":{"message":"!"}}
```

### `GET /config`

The redacted effective configuration text from the `configDump` callback. 404 if the server
wasn't given one — this endpoint never fabricates or exposes the raw configuration.

### `POST /reload`

Triggers a hot reload through the `onReload` callback and returns its structured result: 200 with
`{"ok":true,"added":[...],"removed":[...],"changed":[...],"unchanged":[...]}` on success, or 422
with `{"ok":false,"errors":[...]}` (validation diagnostics) when the new configuration didn't
build. 404 if the server wasn't given a reload handler. This is the one mutating endpoint.

## Security

- **Binds to `127.0.0.1` by default.** Widening `address.host` is an explicit, deliberate choice.
- **Bearer token auth** (`auth.token`): compared with a constant-time, fixed-length digest
  comparison (`node:crypto`'s `timingSafeEqual` over SHA-256 digests of both sides), so neither the
  token's length nor its content is observable through timing. The token is never logged. Required
  for `POST /reload` (the only mutating endpoint) whenever `auth` is configured; required for every
  endpoint, including the health probes, only if `auth.requireForAll` is set.
- **DNS-rebinding protection:** when bound to a loopback address, a request whose `Host` header
  doesn't name that loopback address (at the bound port) or an entry in `allowedHosts` is rejected
  with 403, before routing.
- **CORS is not supported.** No `Access-Control-Allow-Origin` header is ever sent.
- **Bounded request bodies and timeouts:** `maxBodyBytes` caps request bodies (413 and the
  connection is closed if exceeded); `requestTimeoutMs` caps non-streaming requests (`/tap` is
  exempt by design).
- **No stack traces leave the process.** An unexpected (non-`FerruleError`) exception is logged in
  full and reported to the client as a generic 500.

## The client

`AdminClient` is a small client for the endpoints above, built directly on `node:http` (not
`fetch`) so `/tap` can be read incrementally without depending on the platform's Web Streams / Node
interop. It decodes JSON with `@ferrule/core`'s lossless `parseJson`, so integers, bytes, and
timestamps come back as the right `Value` kind.

```ts
import { AdminClient } from '@ferrule/admin';

const client = new AdminClient({ baseUrl: 'http://127.0.0.1:9090', token: adminToken });

const health = await client.health();
const topology = await client.topology();
const metrics = await client.metrics();
const detail = await client.component('app_logs');
const config = await client.config();
const result = await client.reload();

for await (const event of client.tap('app_logs', { sample: 0.1, limit: 100 })) {
  console.log(event);
}
```

`tap()` closes its underlying connection (ending the server-side subscription) as soon as the
caller stops iterating — by `break`ing out of the loop, by the stream ending on its own (e.g. via
`options.limit`), or by the client itself being interrupted.
