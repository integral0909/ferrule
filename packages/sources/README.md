# `@ferrule/sources`

Every source Ferrule ships: HTTP/OTLP/syslog/StatsD receivers, a file tailer, a Prometheus
scraper, a demo generator, stdin, a heartbeat, and Ferrule's own internal metrics. This package
implements the `sources` row of the [architecture doc's](../../docs/architecture.md) §3 package
table and the M6 roadmap item. Every source is a `SourceDefinition` (see
`@ferrule/runtime`'s `defineSource`), registered individually or all at once via
`builtinSources()`:

```ts
import { builtinSources } from '@ferrule/sources';
import { ComponentRegistry } from '@ferrule/runtime';

const registry = new ComponentRegistry();
for (const source of builtinSources()) registry.register(source);
```

## Contents

- [Shared conventions](#shared-conventions)
- [`http_server`](#http_server)
- [`otlp`](#otlp)
- [`syslog`](#syslog)
- [`file`](#file)
- [`statsd`](#statsd)
- [`prometheus_scrape`](#prometheus_scrape)
- [`demo_logs`](#demo_logs)
- [`stdin`](#stdin)
- [`heartbeat`](#heartbeat)
- [`internal_metrics`](#internal_metrics)

## Shared conventions

**Acknowledgements.** Every source creates a `BatchNotifier` (`@ferrule/core`) per unit of work
(one HTTP request, one syslog message, one file read chunk, one scrape round, ...), attaches an
`EventFinalizer` to every event it produces, seals the batch once every event is attached, and
`await`s `ctx.output.send(...)`. When `ctx.acknowledgements` is on, the source then `await`s
`batch.completion` and acts on the result — respond with a status code, advance a checkpoint, log
a warning — before moving on; when it's off, the source acts immediately once `send()` resolves,
without waiting for downstream delivery. This is uniform across every source in this package, even
ones with no protocol-level way to acknowledge upstream (syslog, StatsD, the file tailer): the
acknowledgement flow still matters there for observing backpressure and for correctness (a file
checkpoint, for instance, must never advance past data that wasn't actually delivered).

**Backpressure.** Sources `await ctx.output.send(...)`, which is how the bounded-channel
backpressure described in the architecture doc (§4.2) reaches a source. Each source translates a
slow/full downstream into the appropriate protocol-level pushback: an HTTP-based source
(`http_server`, `otlp`) races the send against a timeout and replies `503` with `Retry-After` if
it's exceeded (the events already handed to the channel are _not_ withdrawn — they may still be
delivered after the response is sent, which is why this is `at-least-once`, not exactly-once); a
TCP-based source (`syslog`, `statsd`) pauses the socket while a send is pending, so the OS-level
receive window applies real back-pressure to the sender; a UDP-based source has no such mechanism
(datagrams are inherently best-effort), so it bounds how many sends may be in flight at once and
drops (counted) beyond that.

**Graceful shutdown.** Every source stops accepting _new_ work as soon as `ctx.signal` aborts (new
connections are refused, new poll rounds don't start) but lets work already accepted finish —
including its acknowledgement wait — before `run()` returns. A subtlety worth calling out because
it's easy to get backwards: the _timers_ that race against backpressure (deciding when to give up
and reply `503`) are deliberately **not** tied to `ctx.signal`, because `ManualClock.sleep(ms,
signal)` (and the real one) rejects the instant the signal aborts — tying them together would make
a graceful shutdown look identical to a backpressure timeout and abandon in-flight requests instead
of letting them finish. The _between-rounds_ wait in a polling loop (`file`, `prometheus_scrape`,
`demo_logs`, `heartbeat`, `internal_metrics`) _is_ tied to `ctx.signal`, since waiting there isn't
in-flight work — aborting it early is exactly what should happen.

**TLS and auth.** `http_server`, `otlp`, and `syslog`'s TCP listener share one TLS options schema
and loader (`certFile`/`keyFile`/optional `caFile` + client-certificate verification) and, for the
two HTTP-based sources, one auth schema (`none` / `bearer` / `basic`, constant-time credential
comparison). Secrets (`auth.token`, `auth.password`) are marked `.secret()` and are never echoed
back in an error response.

**Codecs.** No source in this package re-implements a wire format. Decoding always goes through
`@ferrule/codecs`'s registry (`json`, `ndjson`, `text`, `logfmt`, `csv`, `syslog`, `otlp_protobuf`,
`otlp_json`, `prometheus_text`, `statsd`, `pattern`) or its dedicated decoder functions, and framing
(splitting a byte stream into records) always goes through its `Framer` implementations
(`NewlineFramer`, `OctetCountingFramer`, ...).

---

## `http_server`

Receives log, metric, or span events as HTTP POST request bodies, decoded through any codec in the
registry. Bodies are split into decoder frames one of two ways: `newline` (one frame per line —
the default for line-oriented codecs like `ndjson`/`logfmt`) or `whole` (the entire body is one
frame — the default for document codecs like `json`/`csv`).

| Option                     | Type               | Default                  | Description                                                                   |
| -------------------------- | ------------------ | ------------------------ | ----------------------------------------------------------------------------- |
| `address`                  | socket address     | `0.0.0.0:8080`           | Listen address. Port `0` binds an ephemeral port.                             |
| `paths`                    | `string[]`         | `["/"]`                  | Request paths that accept event POSTs.                                        |
| `healthPath`               | `string`           | `/health`                | Path answering liveness checks with 200.                                      |
| `decoding`                 | codec name         | `ndjson`                 | Codec used to decode request bodies.                                          |
| `decodingOptions`          | any                | —                        | Passed through to the codec's decoder.                                        |
| `framing`                  | `newline \| whole` | inferred from `decoding` | Overrides the codec-based framing default.                                    |
| `maxLineLength`            | byte size          | `1MiB`                   | Max frame length when `framing` is `newline`.                                 |
| `maxBodyBytes`             | byte size          | `10MiB`                  | Max **decompressed** body size. Larger bodies get `413`.                      |
| `maxCompressedBodyBytes`   | byte size          | = `maxBodyBytes`         | Max body size on the wire, before decompression (zip-bomb bound).             |
| `maxConcurrentRequests`    | integer            | `1024`                   | Requests processed at once. Excess requests get `429` immediately.            |
| `requestTimeoutMs`         | duration           | `30s`                    | Time allowed to receive a full request.                                       |
| `backpressureTimeoutMs`    | duration           | `5s`                     | How long a request waits for backpressure to clear before a `503`.            |
| `auth`                     | object             | `{ scheme: "none" }`     | `scheme: none \| bearer \| basic`, plus `token` / `username` / `password`.    |
| `tls`                      | object, optional   | —                        | `certFile`, `keyFile`, optional `caFile`, `requestClientCert`.                |
| `trustForwardedFor`        | boolean            | `false`                  | Take the client address from `X-Forwarded-For` (only behind a trusted proxy). |
| `metadata.remoteAddrField` | string             | `http.remote_addr`       | Field the client address is written to.                                       |
| `metadata.pathField`       | string             | `http.path`              | Field the request path is written to.                                         |
| `metadata.queryField`      | string             | `http.query`             | Field the raw query string is written to.                                     |
| `metadata.headers`         | `string[]`         | `[]`                     | Header names copied to `http.headers.<lowercased name>`.                      |

```yaml
sources:
  app_logs:
    type: http_server
    address: 0.0.0.0:8080
    decoding: ndjson
    auth:
      scheme: bearer
      token: ${secret:INGEST_TOKEN}
    metadata:
      headers: [x-request-id]
```

**Responses:** `200` (with `{"accepted": n}`) on success, `204` for an empty/zero-event body,
`400` for a decode error or a `'rejected'` acknowledgement (with a JSON `{"error":{"code",
"message"}}` body that never echoes headers or credentials), `401`/`403` for auth failures, `413`
for an oversize body, `415` for an unsupported `Content-Encoding`, `429` over
`maxConcurrentRequests`, `503` with `Retry-After` for a backpressure timeout or an `'errored'`
acknowledgement, `500` for a genuine bug. `GET <healthPath>` answers `200` (`503` while shutting
down). Gzip/deflate/brotli request decompression is bounded on both the wire size and the
decompressed size, so a small compressed body can't be used to force unbounded allocation.

---

## `otlp`

An OTLP/HTTP receiver — the standard OpenTelemetry Protocol over HTTP. Shares its HTTP plumbing
with `http_server` (bounded/decompressing body reads, optional auth/TLS, response helpers); what's
specific to it is OTLP's fixed routing, its two wire formats, and its response conventions.

| Option                   | Type             | Default              | Description                                                     |
| ------------------------ | ---------------- | -------------------- | --------------------------------------------------------------- |
| `address`                | socket address   | `0.0.0.0:4318`       | Listen address (4318 is the conventional OTLP/HTTP port).       |
| `basePath`               | string           | `/v1`                | POSTs to `<basePath>/logs`, `/metrics`, `/traces` are accepted. |
| `healthPath`             | string           | `/health`            | Path answering liveness checks with 200.                        |
| `maxBodyBytes`           | byte size        | `10MiB`              | Max decompressed body size.                                     |
| `maxCompressedBodyBytes` | byte size        | = `maxBodyBytes`     | Max body size on the wire.                                      |
| `maxConcurrentRequests`  | integer          | `1024`               | Requests processed at once.                                     |
| `requestTimeoutMs`       | duration         | `30s`                | Time allowed to receive a full request.                         |
| `backpressureTimeoutMs`  | duration         | `5s`                 | How long a request waits for backpressure before a `503`.       |
| `auth`                   | object           | `{ scheme: "none" }` | Same shape as `http_server`'s `auth`.                           |
| `tls`                    | object, optional | —                    | Same shape as `http_server`'s `tls`.                            |

```yaml
sources:
  otel:
    type: otlp
    address: 0.0.0.0:4318
```

**Content types:** `application/x-protobuf` and `application/json` (OTLP/JSON), each optionally
gzip-compressed; anything else gets `415`. **Responses** are always `Export<Signal>ServiceResponse`
messages on success (`200`, encoded in the same wire format as the request — empty when nothing
was rejected) and `google.rpc.Status`-shaped bodies on failure (`code`/`message`): `400`
(`INVALID_ARGUMENT`) for a decode error or a `'rejected'` acknowledgement, `401`/`403` for auth,
`413` (`RESOURCE_EXHAUSTED`) for an oversize body, `429` over the concurrency limit, `503`
(`UNAVAILABLE`, with `Retry-After`) for a backpressure timeout or an `'errored'` acknowledgement.
This receiver decodes a request atomically (one bad record fails the whole request, per
`@ferrule/codecs`'s OTLP decoders) and acknowledges per request, so `partial_success` is always
sent empty/omitted in practice — see the comment above `sendSuccess` in `src/otlp.ts` for the full
reasoning and what would need to change to populate it.

---

## `syslog`

Receives syslog messages over TCP and/or UDP (at least one must be configured). Framing (RFC 6587
octet-counting with an automatic newline-delimited fallback) and parsing (RFC 5424 / RFC 3164) are
both owned by `@ferrule/codecs`.

| Option                      | Type                         | Default       | Description                                                          |
| --------------------------- | ---------------------------- | ------------- | -------------------------------------------------------------------- |
| `tcp.address`               | socket address               | `0.0.0.0:601` | TCP listen address.                                                  |
| `tcp.tls`                   | object, optional             | —             | Same shape as `http_server`'s `tls`.                                 |
| `tcp.maxConnections`        | integer                      | `1024`        | Additional connections over this are refused immediately.            |
| `tcp.maxFrameLength`        | byte size                    | `1MiB`        | Max message length (octet-counted or newline-framed).                |
| `tcp.idleTimeoutMs`         | duration                     | `300s`        | A connection sending nothing for this long is closed.                |
| `udp.address`               | socket address               | `0.0.0.0:514` | UDP listen address.                                                  |
| `udp.maxPacketBytes`        | byte size                    | `64KiB`       | Datagrams larger than this are dropped and counted.                  |
| `udp.maxConcurrentSends`    | integer                      | `256`         | Max in-flight `output.send` calls; beyond it, datagrams are dropped. |
| `format`                    | `auto \| rfc5424 \| rfc3164` | `auto`        | Which decoder to use; `auto` detects per message.                    |
| `decodeErrors.logLevel`     | `debug \| warn`              | `debug`       | Log level for a message that fails to decode.                        |
| `decodeErrors.snippetBytes` | integer                      | `200`         | Bytes of a malformed message included (truncated) in the log line.   |

```yaml
sources:
  syslog_in:
    type: syslog
    tcp:
      address: 0.0.0.0:601
    udp:
      address: 0.0.0.0:514
```

Every decoded event gets `syslog.peer_addr` / `syslog.peer_port` from the actual socket peer,
distinct from whatever `.hostname` the message body itself claims. A message that fails to decode
is counted (`component_errors_total`, `component_discarded_events_total`) and skipped — it never
kills a connection or the source. TCP applies backpressure by pausing the socket (through the
acknowledgement wait too, when acknowledgements are on) rather than buffering; UDP has no such
mechanism, so `udp.maxConcurrentSends` bounds in-flight work and excess datagrams are dropped and
counted (`syslog_udp_packets_dropped_total`) — the same trade-off StatsD's UDP listener makes,
documented in both sources' code.

---

## `file`

Tails files matching glob patterns, with crash-safe, acknowledgement-driven checkpoints persisted
in `ctx.dataDir` (this source fails at build time with a clear error if no data directory is
configured). Poll-based — `fs.watch` is used only as a hint to wake a poll early; the poll loop is
always authoritative, so behavior is identical on every OS and filesystem.

| Option                          | Type               | Default     | Description                                                                  |
| ------------------------------- | ------------------ | ----------- | ---------------------------------------------------------------------------- |
| `include`                       | `string[]`, min 1  | —           | Glob patterns of files to tail (`*`, `**`, `?`, `[...]`, `{a,b}`).           |
| `exclude`                       | `string[]`         | `[]`        | Glob patterns to exclude, even if matched by `include`.                      |
| `readFrom`                      | `beginning \| end` | `end`       | Where a newly discovered file (no checkpoint yet) starts reading from.       |
| `pollIntervalMs`                | duration           | `1s`        | How often the file set and sizes are re-scanned.                             |
| `maxOpenFiles`                  | integer            | `64`        | Max files tailed at once; extra discoveries are deferred to a later poll.    |
| `maxLineLength`                 | byte size          | `1MiB`      | Longer lines are truncated (and counted) at this length.                     |
| `maxReadBytesPerTick`           | byte size          | `1MiB`      | Max bytes read from one file per poll, so many active files stay responsive. |
| `ignoreOlderThanMs`             | duration, optional | —           | Ignore files whose mtime is older than this.                                 |
| `fingerprintBytes`              | byte size          | `256`       | Bytes hashed at the start of a file to validate a resumed checkpoint.        |
| `decoding`                      | codec name         | `text`      | Codec used to decode each line.                                              |
| `decodingOptions`               | any                | —           | Passed through to the codec's decoder.                                       |
| `multiline.startPattern`        | regex              | —           | A line matching this begins a new logical event.                             |
| `multiline.continuationPattern` | regex, optional    | —           | A line matching this is a continuation; unset ⇒ "anything not a start line". |
| `multiline.timeoutMs`           | duration           | `1s`        | Flush the aggregated event if no new line arrives within this long.          |
| `multiline.maxLines`            | integer            | `500`       | Safety bound: force-flush after this many lines.                             |
| `pathField`                     | string             | `file.path` | Field each event is annotated with: the source file's path.                  |
| `hostField`                     | string             | `host`      | Field each event is annotated with: this machine's hostname.                 |

```yaml
sources:
  app_logs:
    type: file
    include: ['/var/log/myapp/*.log']
    decoding: json
    readFrom: end
```

**Checkpoints and identity.** A file is identified by `(device, inode)`; renaming it (the common
`mv current.log old.log && touch current.log` rotation) doesn't change its inode, so a file already
open keeps being read correctly across the rename with no special-casing — this source reads
through the handle, not the path. A copy-truncate rotation (content truncated in place) is detected
directly: if a tracked file's size drops below the read offset, it must have been truncated (normal
appends only grow a file), so the offset resets to 0. When _resuming_ a checkpoint for a file this
process doesn't already have open (typically: after a restart), the checkpoint's content
fingerprint (a hash of the file's first `fingerprintBytes`, hashed over the _same_ byte count that
was originally sampled — not re-derived from the file's current, possibly-grown, size) is
re-validated before trusting the stored offset, guarding against the rare case of the OS reusing an
inode for unrelated content.

**The checkpoint offset only ever advances past fully-decoded, and — when `ctx.acknowledgements` is
on — acknowledged, data**, and it's a single monotonic watermark per file: an `'errored'`
acknowledgement never advances it (so a restart re-reads that data), a `'delivered'` or
`'rejected'` one does (retrying permanently-bad data would just loop forever). Checkpoints are
written atomically (temp file + rename) so a crash mid-write never corrupts the checkpoint file.

---

## `statsd`

Receives StatsD/DogStatsD metrics over UDP and/or TCP (at least one must be configured), via
`@ferrule/codecs`'s StatsD parser — sampling-rate handling, multi-value lines, and DogStatsD tag
extensions are all handled there.

| Option                 | Type           | Default        | Description                                                          |
| ---------------------- | -------------- | -------------- | -------------------------------------------------------------------- |
| `udp.address`          | socket address | `0.0.0.0:8125` | UDP listen address.                                                  |
| `udp.maxPacketBytes`   | byte size      | `65507B`       | Larger datagrams are discarded.                                      |
| `udp.maxInFlightSends` | integer        | `256`          | Max in-flight `output.send` calls; beyond it, datagrams are dropped. |
| `tcp.address`          | socket address | `0.0.0.0:8125` | TCP listen address.                                                  |
| `tcp.maxConnections`   | integer        | `1024`         | Additional connections over this are closed immediately.             |
| `tcp.maxLineLength`    | byte size      | `64KiB`        | Max length of one StatsD line read over TCP.                         |
| `decodingOptions`      | any            | —              | Passed through to the StatsD decoder (e.g. `maxLines`, `maxTags`).   |

```yaml
sources:
  statsd_in:
    type: statsd
    udp:
      address: 0.0.0.0:8125
```

A UDP packet may contain several newline-separated metric lines (decoded as one unit, per the
codec's own packet-level parsing); TCP bytes are framed into individual lines first. A malformed
line/packet is counted and skipped, never crashes a connection or the source. Backpressure and
shutdown follow the same TCP-pause / UDP-bounded-in-flight pattern as `syslog`.

---

## `prometheus_scrape`

Pulls one or more `/metrics` endpoints on an interval and parses them with `@ferrule/codecs`'s
Prometheus text decoder.

| Option               | Type                              | Default              | Description                                                                       |
| -------------------- | --------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `targets`            | array, min 1                      | —                    | `{ url, job?, instance?, labels? }` per target.                                   |
| `targets[].url`      | url (`http`/`https`)              | —                    | The `/metrics` endpoint to scrape.                                                |
| `targets[].job`      | string, optional                  | `prometheus_scrape`  | The `job` label set on every metric from this target.                             |
| `targets[].instance` | string, optional                  | target's `host:port` | The `instance` label set on every metric from this target.                        |
| `targets[].labels`   | `Record<string,string>`, optional | —                    | Additional static labels applied to every metric from this target.                |
| `intervalMs`         | duration                          | `15s`                | Time between the start of one scrape round and the next.                          |
| `scrapeTimeoutMs`    | duration                          | `10s`                | Per-target request timeout (a real timer, since it bounds real I/O).              |
| `concurrency`        | integer                           | `8`                  | Max targets scraped in parallel within one round.                                 |
| `honorLabels`        | boolean                           | `false`              | `false`: config always overwrites same-named scraped labels. `true`: the reverse. |
| `decodingOptions`    | any                               | —                    | Passed through to the Prometheus text decoder.                                    |

```yaml
sources:
  scrape:
    type: prometheus_scrape
    targets:
      - url: http://localhost:9100/metrics
        job: node_exporter
    intervalMs: 15s
```

A scrape failure for one target (connection refused, non-2xx, timeout, malformed body) is caught,
logged, and counted (`prometheus_scrape_failures_total{target}`) — it never aborts the round or
affects other targets. The interval loop runs a round, then `ctx.clock.sleep(intervalMs,
ctx.signal)` before the next (this wait _is_ tied to `ctx.signal`, since it isn't in-flight work);
an in-flight round is allowed to finish on shutdown, but no new round starts.

---

## `demo_logs`

A synthetic log generator for trying Ferrule without any real infrastructure: rate-limited,
seeded (deterministic — the same `seed` and `count` always produce byte-for-byte identical output,
regardless of `eventsPerSecond` or real elapsed time), with a bounded or unbounded event count.

| Option            | Type                                                        | Default | Description                                                        |
| ----------------- | ----------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `format`          | `apache_common \| apache_combined \| json \| syslog \| all` | `json`  | Synthetic shape to generate. `all` round-robins deterministically. |
| `eventsPerSecond` | integer                                                     | `10`    | Events generated together, once per second.                        |
| `seed`            | integer                                                     | `1`     | PRNG seed (mulberry32).                                            |
| `count`           | integer, optional                                           | —       | Stop after this many events. Omit to run until shutdown.           |

```yaml
sources:
  demo:
    type: demo_logs
    format: apache_combined
    eventsPerSecond: 50
```

---

## `stdin`

Reads lines from `process.stdin`, decoded through the codec registry, and ends `run()` cleanly on
EOF (without needing `ctx.signal` to abort). The underlying stream is injectable for tests:
`createStdinSource(stream)` builds an independent instance; `stdinSource` (the default export) is
`createStdinSource()` bound to real `process.stdin`.

| Option            | Type       | Default  | Description                             |
| ----------------- | ---------- | -------- | --------------------------------------- |
| `decoding`        | codec name | `ndjson` | Codec used to decode each line.         |
| `decodingOptions` | any        | —        | Passed through to the codec's decoder.  |
| `maxLineLength`   | byte size  | `1MiB`   | Max length of one line read from stdin. |

```yaml
sources:
  in:
    type: stdin
    decoding: text
```

---

## `heartbeat`

Emits one log event per interval with host/uptime information — useful for verifying a pipeline is
alive end to end.

| Option       | Type     | Default     | Description                                  |
| ------------ | -------- | ----------- | -------------------------------------------- |
| `intervalMs` | duration | `10s`       | How often to emit a heartbeat event.         |
| `message`    | string   | `heartbeat` | Text carried in the event's `message` field. |

```yaml
sources:
  hb:
    type: heartbeat
    intervalMs: 30s
```

---

## `internal_metrics`

Periodically publishes Ferrule's own recorded metrics (event counts, request durations, buffer
depth, and anything else recorded through `ctx.metrics` across the running pipeline) as
`MetricEvent`s — point this at a sink to feed Ferrule's own telemetry into the same backend as
everything else. Requires a `MetricsRecorder` whose `snapshot()` is implemented (the real
`MetricsRegistry` used by a running pipeline always provides one); this source fails fast with a
clear error at the start of `run()` if it isn't available, rather than silently doing nothing.

| Option              | Type             | Default | Description                                                                        |
| ------------------- | ---------------- | ------- | ---------------------------------------------------------------------------------- |
| `intervalMs`        | duration         | `10s`   | How often the current snapshot is published.                                       |
| `namespaceOverride` | string, optional | —       | Replaces every emitted metric's `series.namespace` (the name itself is untouched). |

```yaml
sources:
  self:
    type: internal_metrics
    intervalMs: 15s
    namespaceOverride: ferrule
```
