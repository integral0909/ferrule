# @ferrule/sinks

Ferrule's built-in sinks. `builtinSinks()` returns every definition; `httpFamilySinks()` and
`streamFamilySinks()` return the two groups described below.

Every sink finishes each event's finalizers with its delivery outcome (`delivered`, `errored`
after retries are exhausted, or `rejected` for permanent failures), batches and retries through
the runtime's sink toolkit, and never logs secret option values.

## Shared option fragments

Every sink's option schema uses `snake_case` keys, and a handful of option shapes are identical
across every sink that needs them — defined once in `src/fragments.ts` and reused rather than
redefined per sink. (The HTTP-family-specific fragments — `auth`, `proxy`, `compression` — live in
`src/http/schema.ts`, itself built on top of these.)

- **`tls`** (client side — a sink dialling out to a remote endpoint): `{ enabled?, ca_file?,
cert_file?, key_file?, verify_certificate, server_name? }`. `verify_certificate` defaults to
  `true`; disabling it logs a loud warning. Used by every HTTP-family sink plus `socket`,
  `syslog`, `postgres`, and `kafka`.
- **`batch`**: `{ max_events?, max_size?, timeout }`. Flushes once either bound is hit, or after
  `timeout` (a duration, default `1s`) regardless of size.
- **`retry`**: `{ initial_backoff, max_backoff, max_attempts?, max_duration? }`. Exponential
  backoff with full jitter; the multiplier is fixed at `2` internally and is not
  user-configurable. `max_attempts`/`max_duration` are unbounded by default.
- **`auth`** (HTTP family only): `{ strategy: 'none' | 'basic' | 'bearer' | 'header', ... }` —
  `basic` takes `username`/`password`, `bearer` takes `token`, `header` takes `name`/`value`.
- **`encoding`**: `{ codec, ...codec-specific options }` — `codec` selects the registered
  `@ferrule/codecs` encoder (`json`, `ndjson`, `text`, `logfmt`, the OTLP codecs, ...); any other
  keys are passed straight through to that codec. Mirrors `decoding` on the source side.
- **`framing`** (stream/Kafka family only — the HTTP family has a separate, unrelated concept of
  batch-envelope framing, documented per sink below): `{ method: 'newline' | 'octet_counting' |
'length_prefixed', width?, endianness? }` — `width` (`u16`|`u32`, default `u32`) and
  `endianness` (`BE`|`LE`, default `BE`) only apply to `length_prefixed`.

Durations (`timeout`, `initial_backoff`, `max_backoff`, ...) and byte sizes (`max_size`, ...) never
carry an `Ms`/`_ms`/`_bytes` suffix in a field name — the schema type (`s.duration()`/
`s.byteSize()`) already makes the unit unambiguous.

## Compression

Kafka (`compression: none | gzip | zstd`) and every HTTP-family sink except
`prometheus_remote_write` (`compression: none | gzip | zstd`, sent as `Content-Encoding`)
compress with Node's built-in `node:zlib`; no compression library is bundled. zstd needs Node
22.15+, which is why that is the workspace's `engines` floor. `lz4` and `snappy` remain
unimplemented for Kafka: see issue #16 for why LZ4 was dropped.

### zstd level

Both families take `zstd_level` (1–22, default **3**; ignored unless `compression` is `zstd`). 3
matches Kafka's `compression.zstd.level` default and the zstd CLI. **On our JSON log data, level 1
was both faster and smaller than 3**, so it is worth trying. Codec-only numbers for the records
section of a 500-event batch (157 KiB), from `bench/kafka-compression.ts` on Node 22.23:

| codec  | size vs raw | compress | decompress |
| ------ | ----------- | -------- | ---------- |
| gzip-6 | 17.8%       | 81 MB/s  | 488 MB/s   |
| zstd-3 | 19.8%       | 217 MB/s | 609 MB/s   |
| zstd-1 | 18.6%       | 298 MB/s | 613 MB/s   |

zstd compresses about 2.5–3× faster than gzip, but on this data gzip's output is the smallest.
Measure on your own data before choosing: the ranking depends heavily on content. Cost climbs
steeply with level: on a 3.8 MiB body, level 3 took ~50 ms, 9 took ~250 ms and 19 took ~7 s. The
HTTP client compresses on the libuv threadpool, but the Kafka encoder runs on the event loop, so
high levels there stall the pipeline. End to end,
per-record Kafka framing currently costs more than either codec. Re-run with:

```sh
pnpm run build && node --experimental-strip-types packages/sinks/bench/kafka-compression.ts
```

### Decompression (`src/compression/zstd.ts`)

All zstd use goes through one wrapper, because the `node:zlib` zstd API is still marked
experimental. `zstdDecompress` is bounded (512 MiB by default) and fails with coded errors only
(`E_ZSTD_TRUNCATED`, `E_ZSTD_CORRUPT`, `LimitExceededError`). Before decompressing, it walks the
frame and block headers itself, because `node:zlib` (checked on 22.15 and 22.23) never verifies
that a frame ended: a truncated frame comes back short or empty with no error, a frame missing only
its checksum comes back unverified, and only the first of several concatenated frames is decoded.
The wrapper turns the first two into errors and decodes every frame, as the zstd CLI does. Kafka's
`decodeRecordBatch` bounds gzip the same way; `gunzipSync` already reports truncation itself.

### Interop tests

`test/compression/zstd-interop.test.ts` checks both directions against the reference zstd CLI:

- **CLI → us:** fixtures in `test/compression/fixtures/` were written by the CLI (version in
  `manifest.json`; regenerate with `generate.sh`) and must decode to the original bytes. These
  always run.
- **Us → CLI:** needs the CLI at test time: set `ZSTD_CLI` or put `zstd` on `PATH`. The tests
  skip without it, unless `REQUIRE_ZSTD_CLI=1` (set on CI's Linux jobs) makes that a failure.

## HTTP-family sinks

This section covers the eight HTTP(S)-based sinks: `http`, `loki`,
`clickhouse`, `object_storage`, `otlp`, `prometheus_remote_write`, `prometheus_exporter`, and
`elasticsearch`. All of it lives under `src/http/` (plus the barrel `src/http-family.ts`, which
exports every definition here and `httpFamilySinks()`); it shares no code with the sinks built in
`src/stream-family.ts`. Node stdlib only — no third-party HTTP client, AWS SDK, protobuf compiler,
or compression library.

### Shared HTTP client (`src/http/client.ts`)

Every HTTP-based sink in this package is built on one `HttpClient`:

```ts
const client = new HttpClient({
  auth, // { strategy: 'none' | 'basic' | 'bearer' | 'header', ... } — see the shared `auth` fragment
  tls, // { ca_file?, cert_file?, key_file?, verify_certificate } — verify_certificate: false logs a loud warning
  proxy, // { use_env, url? } — HTTP(S)_PROXY / NO_PROXY by default, or an explicit override
  timeoutMs,
  maxResponseBytes,
  compression, // 'none' | 'gzip' | 'zstd' — compresses the request body, sets Content-Encoding
  zstdLevel, // 1–22, default 3; only used for 'zstd' (see Compression above)
  headers, // static headers merged into every request; secret values are never logged
  maxSockets,
  logger,
});

const response = await client.request({ method, url, headers, body, signal });
// response is always returned, even for a non-2xx status — call ensureSuccess(response) to
// turn a non-2xx into a classified SinkError the way most sinks here want.
```

Notable pieces:

- **Keep-alive pooling**: one `http.Agent`/`https.Agent` per client (plus one per distinct proxy,
  for the tunnelling case below), reused across requests.
- **TLS**: `resolveTls` (`src/http/tls.ts`) turns `ca_file`/`cert_file`/`key_file` into the
  `Buffer`s Node's `tls` module wants, and logs once at build time if verification is disabled.
- **Proxying** (`src/http/proxy.ts`): `resolveProxy` implements `HTTP_PROXY`/`HTTPS_PROXY`/
  `NO_PROXY` resolution (exact and suffix `NO_PROXY` matches, `*` to disable entirely, explicit
  overrides). A plain `http://` target behind a proxy is simply addressed to the proxy with an
  absolute-form request line; an `https://` target is tunnelled through a hand-written `CONNECT`
  handshake (`TunnelingHttpsAgent`), after which TLS is negotiated over the raw tunnelled socket.
- **Status classification** (`src/http/status.ts`): `classifyHttpStatus`/`ensureSuccess` turn a
  response into a `SinkError` — `429`/`5xx`/`408` retryable (honouring `Retry-After`, both the
  integer-seconds and HTTP-date forms), every other `4xx` permanent.
- **Response bounds**: reading stops and the request fails (`E_HTTP_RESPONSE_TOO_LARGE`,
  permanent) once `maxResponseBytes` is exceeded; `gzip`/`deflate`/`br` response bodies are
  decompressed transparently based on `Content-Encoding`.

### Field templating (`src/http/templating.ts`)

`compileFieldTemplate('{{ service }}/{{ http.status }}')` compiles `{{ field.path }}`
placeholders once; `render(context, encode?)` substitutes each one from a `ValueMap` "context"
(`eventContext()` in `src/http/support.ts` builds one from any event kind — a `LogEvent`'s own
fields directly, or a small synthetic map for metrics/spans). The text **between** `{{` and `}}`
is restricted to a safe allow-list (letters, digits, `_.[]-@` and quoted segments) — the same
characters `@ferrule/core`'s own field-path grammar accepts — so a template can never smuggle
path/URL metacharacters into a rendered value through the placeholder syntax itself; encoding the
substituted _value_ (which is untrusted event data) is the caller's job, via `encode` (e.g.
`encodeUriValue` for a URL). `formatTimePattern` is a minimal `strftime` (`%Y %m %d %H %M %S %j
%s %%`) for time-partitioned templates.

### Batch framing (`src/http/framing.ts`)

`frameChunks(perEventChunks, 'ndjson' | 'json_array' | 'newline')` joins already-encoded per-event
byte chunks into one request body; `contentTypeFor` gives a matching default `Content-Type`.

### Sinks

| Type                      | Destination                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http`                    | Any HTTP(S) endpoint               | Field-templated URL, encoding + framing + compression, generic auth.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `loki`                    | Loki-compatible push API           | Labels from templates (validated names), partitioned per resolved label set via `runBatchedSink`'s `partitionKey`, a label-cardinality cap (new streams past it are rejected, not sent), optional entry sort for out-of-order protection, tenant header.                                                                                                                                                                                                                                                                   |
| `clickhouse`              | ClickHouse HTTP interface          | `INSERT INTO db.table FORMAT JSONEachRow`; identifiers are validated and backtick-quoted (`quoteClickHouseIdentifier`); rows are encoded with core's lossless JSON encoder so `int64` columns keep full precision; optional field→column mapping; arbitrary settings as query params.                                                                                                                                                                                                                                      |
| `object_storage`          | Any S3-compatible store            | Hand-written AWS **SigV4** header signing (`src/http/sigv4.ts`); path-style or virtual-hosted addressing; `%Y/%m/%d/%H`-style + field-templated object keys with an always-appended random suffix; gzip.                                                                                                                                                                                                                                                                                                                   |
| `otlp`                    | An OTLP/HTTP collector             | Logs/metrics/traces, protobuf or JSON, via `@ferrule/codecs`'s OTLP codecs; a 2xx response with `partial_success` is still `delivered` (logged, per the OTLP spec's own semantics) — only a non-2xx status is a delivery failure.                                                                                                                                                                                                                                                                                          |
| `prometheus_remote_write` | A Prometheus remote-write endpoint | `prompb.WriteRequest` built with the codecs package's `ProtoWriter`; counters/gauges map directly, histograms/summaries expand into `_bucket`/`_sum`/`_count`/`quantile` series, and exponential histograms are converted to explicit `_bucket` series after accumulation (see below); `incremental` metrics are accumulated into absolute totals with a staleness bound (`MetricAccumulator`, `src/http/prom-remote-write.ts`); compressed with a **hand-written Snappy block-format compressor** (`src/http/snappy.ts`). |
| `prometheus_exporter`     | Pull: serves `/metrics` itself     | A real `node:http` server (port `0` supported for tests); keeps the latest/accumulated value per series with the same staleness-bound logic (exponential histograms are kept as such and converted only when scraped); events are `delivered` as soon as they're incorporated into the served state, independent of any scrape.                                                                                                                                                                                            |
| `elasticsearch`           | Elasticsearch/OpenSearch `_bulk`   | Index name templated with date tokens + fields, evaluated per event; `_id` from a configured field; **per-item** bulk-response status resolved to each event's own delivery status (`delivered`/`errored`/`rejected`), independent of the other events in the batch; data-stream mode forces the `create` action.                                                                                                                                                                                                          |

**Exponential histograms and Prometheus.** Neither Prometheus sink sends native histograms, so an
`exponential_histogram` leaves them as a classic histogram, converted with core's
`exponentialToExplicitHistogram`: positive bucket `i` at scale `s` becomes `le="2^((i+1)·2^-s)"`,
the negative range is mirrored, and a non-zero zero count becomes one bucket at
`le="<zero threshold>"`. Conversion happens only at the edge: incremental points are first merged
as exponential histograms (downscaling to a common scale, see `addMetricValues`), so points at
different scales add up rather than restarting the series. The conversion is lossy, and the `le`
boundaries a series exposes change whenever its scale does. A point whose boundaries would overflow
a double (only at very low scales) is `rejected` rather than sent or served.

Every sink shares the same batching/retry/concurrency knobs (the `batch` and `retry` fragments
above, plus `concurrency`), all optional with the fragments' own defaults, and is built on
`@ferrule/runtime`'s `runBatchedSink` — none of them reimplement batching, retry with jittered
backoff, or circuit breaking.

### AWS Signature Version 4 (`src/http/sigv4.ts`)

A hand-written implementation of the header-based signing flow documented at
<https://docs.aws.amazon.com/general/latest/gr/sigv4-calculate-signature.html>: canonical request
→ its SHA-256 → string to sign → a four-step `HMAC-SHA256` key derivation chain → the final
signature. Tests reproduce AWS's own documented example inputs (the placeholder credentials
`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, used throughout AWS's SigV4
documentation) and verify the resulting canonical request, string to sign, and signature against
values computed independently (directly from Node's `crypto` primitives against the documented
algorithm, not through this package's own code) — see `test/http/sigv4.test.ts`.

### Snappy (`src/http/snappy.ts`)

A hand-written encoder/decoder for the Snappy "block format"
(<https://github.com/google/snappy/blob/main/format_description.txt>), needed only because
Prometheus remote write mandates Snappy-compressed bodies and no third-party dependency is
available here. The compressor is a straightforward LZ77 matcher over a rolling 4-byte hash (not
the most aggressive possible Snappy encoder, but every element it emits is spec-valid); the
decompressor accepts anything a compliant encoder could produce and never throws anything other
than a `FerruleError` subclass, however malformed the input — exercised by a `fast-check` property
test asserting `decompress(compress(x)) === x` for arbitrary buffers and that decompression of
arbitrary bytes never throws an untyped error.

### Known gaps

- `object_storage` ignores the shared `auth` option entirely (it authenticates every request with
  SigV4 instead); its option schema (`transportSchemaNoAuth`) simply omits the field rather than
  exposing an unused one.
- `prometheus_remote_write` accepts but ignores the shared `compression` and `zstd_level`
  options (the wire format mandates Snappy) rather than layering both.
- The `CONNECT`-tunnel proxy path is tested for its request framing and its failure path (a proxy
  that refuses the tunnel); a full success-path integration test would need a locally trusted TLS
  certificate for the "origin" server behind the tunnel, which isn't set up here.
- `prometheus_remote_write`/`prometheus_exporter` do not emit explicit Prometheus staleness
  markers (a sample of `NaN` with a specific bit pattern) for a series that ages out — the
  staleness bound only stops accumulating into a now-meaningless total (remote write) or stops
  serving the series (the pull exporter); nothing is sent to explicitly mark it stale downstream.
- `elasticsearch`'s per-item bulk error handling classifies purely by HTTP-style status code
  (`429`/`5xx` → `errored`, other `4xx` → `rejected`); it does not parse Elasticsearch's specific
  `error.type` strings for finer-grained classification.

## Stream and protocol sinks

This section covers the seven sinks that are not HTTP-based:
`console`, `blackhole`, `file`, `socket`, `syslog`, `postgres`, and `kafka`. All of it lives under
`src/stream/`, `src/postgres/`, and `src/kafka/` (plus the barrel `src/stream-family.ts`, which
exports every definition here and `streamFamilySinks()`); it shares no code with the sinks built
in `src/http-family.ts`. Node stdlib only — no `pg`, no `kafkajs`, no third-party crypto or
compression library. `postgres` and `kafka` are hand-written wire-protocol clients built from each
system's own protocol documentation, not thin wrappers around an existing driver.

### Shared infrastructure (`src/stream/`)

- **`template.ts`** — `compileTemplate('{{ host }}/%Y-%m-%d.log')` compiles a mix of
  `{{ field.path }}` field references and strftime-style specifiers (`%Y %y %m %d %H %M %S %j
%%`) once; `renderTemplate(compiled, event, now)` renders it per event. `getEventField` reads a
  field from any event kind on a best-effort basis (`LogEvent` fields directly; a `MetricEvent`
  exposes `name`/`tags.<key>`; a `SpanEvent` exposes `name`/`attributes.<key>`). Used by `file`'s
  path template, `syslog`'s app-name/hostname templates, and `kafka`'s topic/key/header templates.
- **`frame-writer.ts`** — `frameBytes(mode, payload)` applies one write-direction framing (the
  shared `framing` fragment: `newline`, `length_prefixed` with a configurable `width`/
  `endianness`, or `octet_counting` per RFC 6587) to an already-encoded payload. Mirrors the
  read-direction framers in `@ferrule/codecs`.
- **`backpressure-write.ts`** — `writeWithBackpressure(stream, chunk, signal?)` is the one place
  every sink that writes to a Node stream (`console`, `file`, TCP sockets) waits for `'drain'`
  when `write()` reports a full buffer, per Node's own documented backpressure contract.
- **`wire-transport.ts`** — `TcpTransport`/`UdpTransport` implement the `socket` and `syslog`
  sinks' actual network I/O: a persistent, lazily-(re)dialled TCP/TLS connection (a failed
  `send()` throws a retryable `SinkError` and leaves backoff entirely to the caller's
  `RetryPolicy`, so reconnect-with-backoff is the sink toolkit's retry loop, not a second bespoke
  one) and a connectionless UDP socket. Client TLS uses the shared `tls` fragment (`src/fragments.ts`),
  the same shape every HTTP-family sink uses, reused here by `socket`, `syslog`, `postgres`, and
  `kafka`.
- **`safe-path.ts`** — `containsUnsafeSegment`/`resolveWithinBase` are the `file` sink's traversal
  guard: a templated path fragment containing a `..` segment, a leading `/`/`~`, or a drive letter
  is rejected (the offending event only, not the whole sink) before it ever reaches the
  filesystem.
- **`scram.ts`** — a from-scratch SCRAM-SHA-256 client (RFC 5802 "SCRAM", RFC 7677
  "SCRAM-SHA-256"): `ScramSha256Client` drives the three-message exchange
  (`clientFirstMessage()` → `receiveServerFirstMessage()` → `clientFinalMessage()` →
  `receiveServerFinalMessage()`, which verifies the server's proof and throws on a mismatch).
  Password preparation is a pragmatic subset of SASLprep (RFC 4013): pure-ASCII passwords pass
  through unchanged (exactly what full SASLprep does to them), non-ASCII passwords are
  NFKC-normalised as a best effort. Shared verbatim by `postgres`'s SCRAM auth and `kafka`'s
  SASL/SCRAM-SHA-256 auth — the mechanism is identical, just carried over different framing.

### `console` (`src/stream/console.ts`)

Writes each event, encoded by a configurable codec and framed (newline / length-prefixed /
octet-counting), to an injectable `NodeJS.WritableStream` — `createConsoleSink(options, target)`
takes the stream directly, so tests use an in-memory `PassThrough` instead of `process.stdout`;
the `SinkDefinition` wires the real `process.stdout`/`process.stderr`. Respects backpressure.

### `blackhole` (`src/stream/blackhole.ts`)

Discards every event, finishing it `delivered` immediately. Useful as a benchmark baseline for
the rest of a pipeline. `log_interval` optionally logs a running event/byte count on a
`ctx.clock`-driven timer.

### `file` (`src/stream/file.ts`)

Each event's path template is rendered independently under `base_dir` (`{{ host }}/%Y-%m-%d.log`),
so one sink instance fans out to many files. `FileSinkWriter` keeps an LRU of open file handles
capped at `max_open_files` (evicting the least-recently-used) plus a `ctx.clock`-driven
`idle_close` pass; rotation (`rotate_size`/`rotate_age`) opens a new physical file under an
incrementing `.N` suffix rather than renaming in place, and resumes correctly across a restart by
checking each generation's on-disk size before reusing it. Byte counts that drive rotation are tracked manually
rather than read from `fs.WriteStream.bytesWritten`, which only reflects bytes the OS has
actually flushed and lags well behind `write()` calls — using it produced rotation decisions that
were off by a full write cycle during testing. `gzip: true` pipes writes through `zlib.createGzip()`
before the file stream. `fsync: 'always' | 'interval' | 'none'` controls explicit `fsync(2)`
calls. Directory creation is recursive and automatic; traversal-unsafe rendered paths are
rejected per-event (`safe-path.ts`), never crash the sink.

### `socket` (`src/stream/socket.ts`) and `syslog` (`src/stream/syslog.ts`)

`socket` writes framed, encoded events to a raw TCP (optionally TLS) or UDP destination, its wire
`framing` using the shared `{ method, width?, endianness? }` fragment; `syslog` encodes each event
as one RFC 5424 message (`@ferrule/codecs`'s `encodeSyslog5424`) with facility/severity/app-name
resolved from event fields (`facility_field`, `severity_field` or `level_field` mapped through a
built-in + user-extensible `level_map`, `app_name`/`hostname` templates, `msg_id_field`/
`proc_id_field`/`message_field`) and sends it the same way — `syslog`'s own `framing` stays a
plain `'octet_counting' | 'newline'` enum rather than the shared fragment, since it has no
length-prefixed mode. Both are built on `runBatchedSink` + `wire-transport.ts`: TCP batches
several events per write (up to the shared `batch` fragment's `max_events`/`max_size`, flushing
after `batch.timeout`) and frames each one (`newline` or `octet_counting`, per RFC 6587); UDP
always sends exactly one (unframed) datagram per event, rejecting (not crashing on) one that
exceeds `max_datagram_size`. `connect_timeout` bounds the initial dial; `retry` (the shared
`initial_backoff`/`max_backoff` fragment) governs reconnect backoff. Per-event encode/size
failures are finished individually inside the batch's `encode` callback (which must never throw —
`runBatchedSink` does not guard it) rather than failing the whole batch.

### PostgreSQL sink (`src/postgres/`)

A hand-written PostgreSQL wire protocol v3 client, built from the protocol's message grammar
rather than wrapping `pg`.

- **`wire.ts`** — `PgWriter`/`PgReader` (field-at-a-time message building/parsing) and
  `BackendMessageFramer` (splits a byte stream into `<type><Int32 length><body>` messages,
  bounded by `maxMessageLength` per SECURITY.md's "parsers are bounded").
- **`auth.ts`** — cleartext, MD5 (`md5` + hex(MD5(MD5(password+user)+salt))), and SASL/SCRAM-SHA-256
  (`PostgresScramAuth`, wrapping `stream/scram.ts` with the empty `n=` identity libpq uses, since
  PostgreSQL authenticates by the startup packet's user, not the SCRAM identity).
- **`connection.ts`** — `PgConnection`: `StartupMessage`, optional TLS via `SSLRequest` (an 8-byte
  pseudo-message read outside the normal framer, since the server's `S`/`N` reply precedes any
  length-prefixed message), the authentication state machine, the simple query protocol, the
  extended query protocol (Parse/Bind/Describe/Execute/Sync, text-format parameters and results
  only), and `COPY ... FROM STDIN` (streaming `CopyData` messages with backpressure, `CopyDone`,
  or `CopyFail` on a source error so the server reports a clean SQL error instead of hanging).
  `ParameterStatus`/`NoticeResponse` are transparently intercepted wherever they arrive, since
  PostgreSQL can send either at any point in the protocol.
- **`errors.ts`** — `PostgresError` carries the full SQLSTATE and notice field set;
  `classifySqlState` buckets it into `connection` (class `08`) / `serialization` (`40001`,
  `40P01`) — both retryable — versus `constraint` (class `23`) / `data` (class `22`) / `other` —
  none retryable, since PostgreSQL's error codes are specific enough that guessing retryability
  for an unrecognised class is unsafe.
- **`copy-format.ts`** — `text`-format escaping (backslash, delimiter, `\n`, `\r`; `\N` for
  `NULL`, distinguished from literal two-character `"\N"` data by checking the _raw, still-escaped_
  field before unescaping) with a matching decoder used by the round-trip property test; `csv`-format
  encoding reuses `@ferrule/codecs`'s `quoteCsvField` and force-quotes an empty string (`""`) so it
  is never confused with an unquoted-empty `NULL`.
- **`pool.ts`** — `PgPool`: up to `max_connections` lazily-opened connections, FIFO waiters when
  exhausted, and a connection that fails inside `withConnection` is discarded rather than returned
  to the idle set.
- **`sink.ts`** — batches events (the shared `batch` fragment, via `runBatchedSink`), coerces each
  mapped column (`coerceColumnValue`: `text`/`integer`/`bigint`/`float`/`boolean`/`timestamp`/
  `json`/`bytes`, `bytes` as PostgreSQL's hex `bytea` text form `\x...`) and `COPY`s the batch in
  (`copy_format: 'text' | 'csv'`). On a permanent (constraint/data) error, `copyWithBisection`
  recursively bisects the batch — `COPY` each half separately — to isolate and reject only the
  offending row(s) instead of the whole batch, finishing each event's finalizer directly as it
  resolves (`bisect_on_failure: false` rejects the whole batch instead). `quoteIdentifier` handles
  dotted (`schema.table`) names. `application_name` is sent at startup; `connect_timeout` bounds
  the initial connection, `retry` (the shared fragment) governs reconnect/retry backoff.

### Kafka sink (`src/kafka/`)

A hand-written Kafka producer, built from the protocol's binary message grammar rather than
wrapping `kafkajs`.

- **`primitives.ts`** — `KafkaWriter`/`KafkaReader`: fixed-width integers, the classic
  length-prefixed string/bytes/array encodings, and the "compact" (unsigned-varint-length-prefixed)
  string/array encodings plus the empty tagged-fields terminator that KIP-482 "flexible" API
  versions use. The unsigned-LEB128 + zigzag varint scheme is implemented directly here (the
  same one `@ferrule/codecs` uses internally for protobuf, but that module does not export it).
- **`record-batch.ts`** — `encodeRecordBatch`/`decodeRecordBatch`: RecordBatch v2 (magic byte
  `2`), with every per-record field (timestamp/offset deltas, key/value/header lengths) zigzag
  varint-encoded and the batch's CRC-32C (`@ferrule/buffer`'s `crc32c`, over everything from the
  `attributes` field through the end of the — possibly gzip- or zstd-compressed — records section) computed
  and verified. `decodeRecordBatch` exists for the test suite's fake broker and property tests,
  not the production send path.
- **`murmur2.ts`** — `murmur2` reproduces `org.apache.kafka.common.utils.Utils.murmur2` bit-for-bit
  (Kafka's specific seed `0x9747b28c`, `h = seed ^ length` initialisation, `Math.imul` for Java's
  32-bit signed overflow semantics), so a keyed record lands on the same partition a Java producer
  would pick for the same key. `murmur2Partition` is the classic default partitioner
  (`toPositive(murmur2(key)) % numPartitions`); `RoundRobinPartitioner`/`StickyPartitioner` (KIP-480
  — stays on one partition until `onBatchComplete`) handle unkeyed records.
- **`protocol.ts`** — request/response encode/decode for `ApiVersions` (key 18, v0, classic
  header/body — real brokers always accept it that way, for version discovery before either side
  knows the other speaks flexible headers), `Metadata` (key 3, v9, flexible) and `Produce` (key 0,
  v9, flexible — chosen so the compact string/array and tagged-fields primitives are genuinely
  exercised on the wire, not just unit-tested), and `SaslHandshake`/`SaslAuthenticate` (keys 17/36,
  v1, classic).
- **`sasl.ts`** — SASL/PLAIN (RFC 4616) and SASL/SCRAM-SHA-256 (reusing `stream/scram.ts`,
  configured with the real SASL username this time, unlike PostgreSQL's empty one), run over
  `SaslHandshake` + one or two `SaslAuthenticate` round trips before the connection is used for
  anything else.
- **`connection.ts`** — `KafkaBrokerConnection`: `Int32`-length-prefixed request/response framing
  and correlation-ID-based request pipelining (up to `max_in_flight_requests_per_connection`
  requests may be outstanding at once; responses are matched back to their request by
  `correlation_id`, not by arrival order, since Kafka does not guarantee in-order responses across
  pipelined requests). `sendOneWay` exists specifically for `acks=0` Produce requests, which the
  broker never answers at all.
- **`producer.ts`** — `KafkaProducer`: one connection per broker node (opened lazily), a metadata
  cache (topic → partition → leader, refreshed from any bootstrap broker and invalidated on a
  stale-leader error), and `send()`, which assigns every record's partition (murmur2 for a keyed
  record, sticky/round-robin otherwise), groups by partition and then by that partition's leader
  broker, and issues at most one `Produce` request per broker involved regardless of how many
  topic-partitions it touches. The unit of retry is a `ProduceBatch` handle: `send()` finishes
  each record's event `delivered`/`rejected` directly as its own partition's response arrives and
  marks that partition group settled; a retryable per-partition error is thrown (without finishing
  those events) so the sink's `RetryPolicy` calls `send()` again with the _same_ handle, which
  resends only the groups still unsettled. **Idempotent production** (KIP-98, on by default):
  the producer obtains a producer id with `InitProducerId` (v4), stamps each group's RecordBatch
  once with that id, epoch 0, and the partition's next sequence number, and resends the identical
  bytes on retry, so a group whose response was lost after the broker appended it is recognised as
  a duplicate and acknowledged (error code 0 on modern brokers, `DUPLICATE_SEQUENCE_NUMBER` on
  old ones) rather than appended again. Every group of a round is stamped before any request is
  dispatched, under the identity the round started with, so one leader's sequence error cannot
  leave another leader's group unstamped. A producer-state error (`OUT_OF_ORDER_SEQUENCE_NUMBER`,
  `INVALID_PRODUCER_EPOCH`, `UNKNOWN_PRODUCER_ID` — none of which append) makes the producer fetch
  a fresh id and re-stamp the affected groups once inline, which is also how it recovers after the
  sink abandons a batch mid-sequence. This relies on at most one unsettled batch per partition at
  a time (the sink's default concurrency of one), so a resend always falls inside the broker's
  five-batch duplicate window. With idempotence on, `healthcheck()` also performs
  `InitProducerId`, so a cluster that refuses it (typically a missing `IDEMPOTENT_WRITE` ACL)
  fails the pipeline's startup healthcheck instead of rejecting every batch at runtime; permanent
  rejections, per partition (via the `onPermanentError` hook) or per batch, are logged at error
  level by the sink, since the batched-sink loop itself finishes them silently. `gzip` and
  `zstd` compression are supported (see [Compression](#compression)); `snappy`/`lz4` are not
  and are rejected at encode time. zstd is always safe to send: KIP-110 gates it at a Produce
  version below the v9 this producer speaks.
- **`sink.ts`** — topic/key/header templates (`stream/template.ts`), an `acks` schema of
  `'0' | '1' | '-1'` (mapped to the numeric wire value), `idempotent` (default `true`; the schema
  rejects it with any `acks` other than `'-1'`, since the broker refuses idempotent batches
  otherwise), the shared `encoding`/`batch`/`retry` fragments, and the same `runBatchedSink` +
  never-throws-in-`encode` pattern as `socket`/`syslog`, except that `encode` returns a
  `ProduceBatch` handle so every retry attempt reaches the producer with the same object.
  `client_id` identifies this producer to the broker; `connect_timeout`/`request_timeout` bound
  the connection and each request respectively.

### Testing

Every protocol client is tested against an in-process fake server built from the same wire
primitives, not mocks: `test/stream/support/fake-postgres-server.ts` (an async request/response
pump per connection — trust/cleartext/MD5/SCRAM-SHA-256 auth, the simple and extended query
protocols, `COPY` with byte-for-byte capture and a configurable server-side accept/reject
decision) and `test/stream/support/fake-kafka-broker.ts` (`ApiVersions`/`Metadata`/`Produce`/
`InitProducerId`/SASL, decoding and CRC-verifying every `RecordBatch` it receives, and applying
the broker-side idempotence rules — per-producer sequence checks and a five-batch duplicate
window — so it keeps separate logs of batches _received_ and batches actually _appended_; a
produce hook can inject per-partition errors or "append, then drop the connection before
answering", several instances can form a multi-node cluster with per-partition leaders, and the
idempotence tests assert the appended log holds every record exactly once).
`test/stream/support/scram-server.ts` is a from-scratch SCRAM-SHA-256 _server_-side verifier
shared by both fakes, so the client in `stream/scram.ts` is checked against an independent
implementation, not just against itself; the RFC 7677 §3 published test vector is asserted
exactly (`scram.test.ts`). `murmur2` is
cross-checked against a second, differently-structured implementation of the same documented
algorithm plus a partition-distribution sanity check, rather than asserting memorised hash
constants (see "Known gaps"). Socket-based sinks (`socket`, `syslog`) and both protocol clients
are tested against real TCP/UDP listeners on `127.0.0.1:0`; reconnect/retry paths are driven by
`ManualClock` with a short real-time yield between advances, since the connection attempts
themselves are genuine (if fast, loopback) async I/O.

#### Known gaps

- **SASLprep** implements the common ASCII-safe case exactly; the full RFC 4013 profile
  (prohibited-character tables, bidirectional checks) is not implemented, so a password containing
  unusual Unicode may not normalise identically to a fully RFC-compliant client.
- **`murmur2`** is verified by algorithm-level correctness and cross-implementation/property
  testing, not against memorised published hash constants — the test suite does not assert
  specific magic numbers for named inputs, to avoid asserting a value from memory that could
  itself be wrong.
- **Kafka compression** supports `none` and `gzip` only (no snappy/lz4/zstd, which need a native
  dependency this project avoids). **Transactional production** is not implemented (idempotent
  production is); the idempotence guarantee also assumes one unsettled batch per partition at a
  time, which holds with the sink's fixed concurrency of one but would not if a Kafka sink were
  ever given a wider concurrency limiter.
- **PostgreSQL extended query protocol** supports text-format parameters and results only (no
  binary format), and does not use prepared-statement caching (`Parse` targets the unnamed
  statement every call) — sufficient for the sink's own `COPY`-based inserts, which are the
  primary path, and for simple parameterised queries.
- **TLS** (`postgres`, `kafka`, `socket`, `syslog`) is implemented (`SSLRequest` for PostgreSQL,
  plain TLS upgrade for the others) but is not exercised by the automated test suite, which would
  otherwise need to generate and manage certificates for a fake server; it shares the same
  `node:tls` code path as the rest of the codebase's TLS usage.
