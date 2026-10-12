# `@ferrule/codecs`

Wire formats and framing for Ferrule: everything needed to turn bytes off the wire into
`@ferrule/core` events (`LogEvent` / `MetricEvent` / `SpanEvent`) and back again.

Everything in this package is hand-written against the Node.js standard library — there is no
generated protobuf code and no third-party dependency. Every decoder treats its input as
untrusted: sizes, nesting depth, and element counts are all bounded by configurable limits, and
malformed input always raises a typed `FerruleError` subclass rather than throwing something
unexpected, hanging, or exhausting memory.

```
raw bytes ──▶ Framer ──▶ frame bytes ──▶ Decoder ──▶ Event[] (LogEvent | MetricEvent | SpanEvent)
                                                          │
                                                     Encoder ──▶ frame bytes
```

Sources typically pair a **framer** (splits a byte stream into discrete records) with a **codec**
(decodes one record's bytes into events); sinks do the reverse with an **encoder**. The
[registry](#codec-registry) ties codec names to their `Decoder`/`Encoder` implementations so a
pipeline can select one by a configuration string.

## Contents

- [Framing](#framing)
- [Protobuf wire format](#protobuf-wire-format)
- [OTLP](#otlp)
- [Syslog](#syslog)
- [logfmt, key=value, and CSV](#logfmt-keyvalue-and-csv)
- [Prometheus text exposition format](#prometheus-text-exposition-format)
- [StatsD / DogStatsD](#statsd--dogstatsd)
- [Pattern engine](#pattern-engine)
- [Kafka wire protocol](#kafka-wire-protocol)
- [Codec registry](#codec-registry)
- [Known gaps](#known-gaps)

## Framing

A `Framer` incrementally splits a byte stream into discrete frames:

```ts
interface Framer {
  push(chunk: Uint8Array): Uint8Array[];
  finish(): Uint8Array[];
  reset(): void;
}
```

Every framer here is safe to call with a stream chopped into chunks of any size, down to one byte
at a time — the sequence of frames produced depends only on the concatenation of the pushed bytes,
never on how the caller split them into `push` calls ("chunk-splitting invariance", exercised by a
property test per framer). Buffered, undelimited data is bounded by a configurable
`maxFrameLength`/`maxLineLength`, so a stream that never produces a delimiter cannot grow memory
without bound.

| Framer                 | Format                                 | Notes                                                                                |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `NewlineFramer`        | one record per `\n`                    | strips a trailing `\r` by default (CRLF support); `maxLineLength`, `onOversize`      |
| `DelimiterFramer`      | one record per arbitrary byte sequence | any non-empty delimiter, including multi-byte; `NewlineFramer` is built on top of it |
| `LengthPrefixedFramer` | `<length prefix><payload>`             | `u16`/`u32` width, `BE`/`LE` byte order                                              |
| `VarintLengthFramer`   | `<LEB128 varint length><payload>`      | the delimiter `writeDelimitedTo`-style protobuf streaming uses                       |
| `OctetCountingFramer`  | RFC 6587 `OCTET-COUNT SP MSG`          | auto-falls back to newline framing if the stream's first byte is not a digit         |

`DelimiterFramer`/`NewlineFramer` take an `OversizePolicy` (`'error'` | `'truncate'` | `'skip'`)
for what happens when a frame would exceed its size limit — `error` (the default) raises
`LimitExceededError` immediately, `truncate` emits the first `maxFrameLength` bytes and discards
the rest up to the next delimiter, and `skip` discards the whole frame and emits nothing for it.

`Utf8StreamDecoder` is the "character set" layer: it decodes UTF-8 to text incrementally,
correctly handling a multi-byte sequence split across chunk boundaries. It is a standalone utility
for architectures that want to decode to text _before_ framing (byte-oriented framers above never
need it themselves, since an ASCII delimiter like `\n` can never appear as a continuation byte of
a multi-byte UTF-8 sequence, so a completed frame's bytes are always safe to decode on their own).

## Protobuf wire format

`ProtoReader`/`ProtoWriter` implement the protobuf binary wire format directly — varints
(including 64-bit, as `bigint`), zigzag, fixed32/64, floats/doubles, length-delimited fields,
packed repeated fields, and skipping of unknown fields (including deprecated groups) — with no
`.proto` compiler and no generated message classes. Every OTLP message in this package is decoded
by a small hand-written field-number `switch` over a `ProtoReader`, in the same style you would
write by hand against the protobuf wire format spec.

```ts
const reader = new ProtoReader(bytes, { maxDepth: 64 });
while (!reader.atEnd()) {
  const { field, wireType } = reader.readTag();
  switch (field) {
    case 1:
      name = reader.readString();
      break;
    case 2:
      nested = reader.subReader();
      break; // one nesting level deeper, depth-checked
    default:
      reader.skipValue(wireType); // required for forward compatibility
  }
}
```

`ProtoWriter` builds a message by writing tagged fields; nested messages are written by fully
encoding a child `ProtoWriter` first and then writing its known length followed by its bytes
(size precomputation, rather than reserving space and backpatching — simpler and
allocation-bounded per message). `forEachField` is a convenience wrapper that drives the
tag/dispatch/skip loop for you.

## OTLP

Hand-written decode/encode for the OTLP protobuf and OTLP/JSON wire formats — logs
(`ExportLogsServiceRequest`), metrics (`ExportMetricsServiceRequest`), and traces
(`ExportTraceServiceRequest`) — mapped to and from core's `LogEvent`/`MetricEvent`/`SpanEvent`.
`AnyValue`/`KeyValue`/`ArrayValue`/`KeyValueList`, `Resource`, and `InstrumentationScope` are
shared building blocks across all three signals (`otlp/common.ts`).

OTLP/JSON (`otlp/json.ts`) follows the same field mapping as the protobuf codec, with the
protobuf-JSON conventions: camelCase field names, `int64`/`uint64`/`fixed64` values as decimal
**strings** (`int32`/`uint32`/`fixed32`/enum fields stay plain JSON numbers), and — per OTLP's own
documented exception to generic protobuf-JSON — trace and span IDs as **hex** strings rather than
base64. It is implemented by building an intermediate `Value` tree that mirrors the JSON shape and
serializing it with core's `encodeJson`/`parseJson`, so the same bounded, lossless JSON parser
backs both this codec and the plain `json` one.

### Logs

| OTLP field                 | `LogEvent` field                                                               |
| -------------------------- | ------------------------------------------------------------------------------ |
| `time_unix_nano`           | `.timestamp` (falls back to `observed_time_unix_nano`, then `Timestamp.now()`) |
| `observed_time_unix_nano`  | `.observed_timestamp` (only if set and nonzero)                                |
| `severity_number`          | `.severity_number` (integer, omitted if `0`/unspecified)                       |
| `severity_text`            | `.severity_text` (omitted if empty)                                            |
| `body`                     | `.body` (any core `Value`); a **string** body is also mirrored to `.message`   |
| `attributes`               | `.attributes` (a nested object)                                                |
| `dropped_attributes_count` | `.dropped_attributes_count` (omitted if `0`)                                   |
| `trace_id` / `span_id`     | `.trace_id` / `.span_id` (raw bytes, omitted if empty)                         |
| `Resource.attributes`      | `.resource` (nested object, one per `ResourceLogs`)                            |
| `InstrumentationScope`     | `.scope` (`{ name, version?, attributes }`)                                    |

Encoding is the inverse; any top-level field of `LogEvent.fields` that is not in the table above is
folded into the encoded record's `attributes` instead of being dropped, so `decode(encode(x))`
never loses data a transform added after decoding. Events are grouped into `ResourceLogs`/
`ScopeLogs` by resource and scope identity.

### Traces

The mapping to `Span` is close to direct — `SpanEvent` already has the same shape (trace/span IDs,
kind, timing, status, attributes, events, links, and a `resource`/`scope` **per span**, copied from
its `ScopeSpans`). `dropped_attributes_count`/`dropped_events_count`/`dropped_links_count` and the
`flags` bitfield have no home in the core model and are dropped on decode (encoding always writes
zero for the dropped-counts).

### Metrics

One OTLP `Metric` expands to one `MetricEvent` **per data point** (core's metric model is
per-series, per-point, unlike OTLP's per-metric batching):

- **Gauge** data points become `{ type: 'gauge' }`, kind `absolute`.
- **Sum** data points become `counter` when `is_monotonic`, `gauge` otherwise; kind is
  `incremental` for delta temporality and `absolute` for cumulative (or unspecified, treated as
  cumulative). Encoding is the inverse, with one twist: an `absolute` gauge encodes as OTLP's
  `Gauge` (which has no temporality concept at all), but an `incremental` gauge has no home there,
  so it encodes as a non-monotonic, delta `Sum` instead — the only way to round-trip that kind.
- **Histogram** data points become `{ type: 'histogram' }`. OTLP's `bucket_counts` has one more
  entry than `explicit_bounds` (the implicit `+Inf` overflow bucket); core's histogram already
  represents overflow the same way (`count - sum(bucket.count)`), so the last `bucket_counts` entry
  is simply dropped and `count`/`sum` are carried over directly — no cumulative/non-cumulative
  conversion is needed here (OTLP histogram buckets are already non-cumulative, unlike Prometheus's).
- **ExponentialHistogram** data points are _decode-only_, converted to explicit buckets: with
  `base = 2^(2^-scale)`, positive-range bucket index `i` covers `(base^i, base^(i+1)]` and becomes
  a core bucket at `upperLimit = base^(i+1)`; the negative range mirrors this
  (`upperLimit = -base^i`, emitted from the most-negative index down to the least, so the result is
  ascending); the zero bucket (if `zero_count > 0`) becomes one more bucket at
  `upperLimit = zero_threshold`. This is a lossy but standard "expand to explicit boundaries"
  conversion. Encoding never re-derives an `ExponentialHistogram` — core→OTLP encoding always
  produces a classic `Histogram`.
- **Summary** data points become `{ type: 'summary' }`, kind always `absolute` (OTLP summaries have
  no temporality field at all).

Attributes: since `MetricEvent.series.tags` is a flat `Map<string, string>`, `Resource`
attributes, `InstrumentationScope` name/version/attributes (under an `otel.scope.*` prefix), and
the data point's own attributes are all stringified (see `stringifyValue`, exported from this
package) and merged into `tags` — more specific values override less specific ones, in that order
(data point beats scope beats resource). `description` and `unit` have no equivalent on
`MetricEvent` and are dropped. `set` and `distribution` core metric values have no OTLP
representation; encoding one raises `E_OTLP_UNSUPPORTED_METRIC_TYPE` (convert to a histogram or
summary first, e.g. with core's `samplesToHistogram`). Encoding never reconstructs resource/scope,
since `MetricEvent` does not carry them: output is always one empty `Resource` and one nameless
`InstrumentationScope`.

## Syslog

- **RFC 5424** (`syslog/rfc5424.ts`): structured data (`[id@1 k="v"]`, with `\"`/`\\`/`\]`
  unescaping), `NILVALUE` (`-`) fields, and a leading UTF-8 BOM on the message. `encodeSyslog5424`
  is the only syslog encoder this package ships (per the wire format's own recommendation — RFC
  3164 has no registered structure to encode back into reliably).
- **RFC 3164 / BSD syslog** (`syslog/rfc3164.ts`): the classic `<PRI>Mmm dd hh:mm:ss host
tag[pid]: msg` line, which carries no year and no timezone. The year is inferred from a supplied
  reference clock (`now`): the candidate is `now`'s year, unless that would place the message more
  than a day in the future, in which case the previous year is used (handles a Dec 31 message
  arriving just after midnight on Jan 1). The `timezone` option accepts either a fixed UTC offset
  in minutes or an IANA zone name, resolved with `Intl.DateTimeFormat` — Node's built-in ICU data
  is used as the timezone database, so no separate tz package is needed.
- **Auto-detect** (`syslog/detect.ts`): `detectSyslogFormat`/`decodeSyslogAuto` distinguish the two
  by checking, after an optional `<PRI>`, whether the message starts with the literal version `1`
  followed by a digit or `-` (a 5424 `TIMESTAMP`) — 3164 always starts with a three-letter month
  name instead. Anything matching neither format falls back to a bare `LogEvent.fromMessage`.

Both formats decode to a `LogEvent` with matching field names: `.message`, `.timestamp`,
`.severity`, `.facility`, `.hostname`, `.app_name`, `.proc_id`, and (5424 only) `.msg_id` and
`.structured_data` (a nested object keyed by `SD-ID`).

## logfmt, key=value, and CSV

- **logfmt** (`text/logfmt.ts`): `key=value key2="quoted value" flag` — the format used by Heroku,
  many Go services, and HAProxy. A key with no `=` decodes to boolean `true` (a flag); quoted
  values support `\"`, `\\`, `\n`, `\t`, `\r`, and `\uXXXX` escapes.
- **key=value** (`text/keyvalue.ts`): a generalization of logfmt with configurable pair separator,
  key/value separator, and quote character, so it also reads `k1=v1; k2=v2` (semicolon-separated
  connection strings) or `k1:v1,k2:v2` shapes. A bare key with no separator decodes to an empty
  string (not a flag — pass your own default if you need flag semantics).
- **CSV** (`text/csv.ts`): RFC 4180 — quoted fields may contain the delimiter, an embedded literal
  newline, and an escaped quote (`""`); rows are terminated by `\r\n`, bare `\n`, or bare `\r`.
  `CsvParser` is a streaming, chunk-boundary-safe parser (`push`/`finish`, like a `Framer` but
  yielding parsed rows instead of raw frames); `parseCsv` wraps it for a whole document at once.
  `decodeCsvToLogEvents` uses the first row as a header (configurable) to name each column; a short
  row leaves the missing columns unset, a long one keeps the extras under `column<N>`.

All three decode into a `LogEvent` by mapping each key/column directly to a top-level field.

## Prometheus text exposition format

`prometheus/text.ts` parses the `text/plain; version=0.0.4` format scraped from `/metrics`
endpoints: `# HELP`/`# TYPE` metadata, `name{label="value",...} value [timestamp]` samples with
label escaping (`\\`, `\"`, `\n`), and `NaN`/`+Inf`/`-Inf` values.

`decodePrometheusText` assembles `histogram`/`summary` **families**: samples are grouped by base
name (`_bucket`/`_sum`/`_count` suffix stripped, `_sum`/`_count` suffix stripped for summaries)
with the `le`/`quantile` label removed from the grouping key, one `MetricEvent` per remaining
label combination. Prometheus exposes **cumulative** bucket counts; core histograms are
**non-cumulative**, so decoding subtracts consecutive cumulative counts
(`buckets[i] = cumulative[i] - cumulative[i-1]`) and takes the total straight from `_count`.
Everything else (`counter`/`gauge`/untyped) maps one sample to one `MetricEvent`.

`encodePrometheusText` is the inverse for the direction that needs real conversion: core histogram
buckets (non-cumulative) become Prometheus `le` buckets by running a cumulative sum across them,
plus a synthesized `+Inf` bucket equal to the total `count`.

## StatsD / DogStatsD

`statsd/statsd.ts` parses `name:value|type[|@sampleRate][|#tag1:v1,tag2]` lines, including
DogStatsD's multi-value shorthand (`name:v1:v2:v3|type|...`, expanded to several samples sharing
the type/rate/tags) and tag extensions. Unrecognised `|`-segments (e.g. DogStatsD's
`|c:<container-id>`) are ignored for forward compatibility.

| StatsD type                                    | `MetricValue`                                                                                 | kind                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `c` (counter)                                  | `{ type: 'counter' }`, value ÷ `sampleRate`                                                   | `incremental`                                                                                    |
| `g` (gauge)                                    | `{ type: 'gauge' }`                                                                           | `incremental` if the value has an explicit `+`/`-` sign (a relative adjustment), else `absolute` |
| `ms`/`h` (timer/histogram), `d` (distribution) | one-sample `{ type: 'distribution', statistic: 'histogram' }`, `Sample.rate = 1 / sampleRate` | `incremental`                                                                                    |
| `s` (set)                                      | `{ type: 'set', values: {member} }`                                                           | `incremental`                                                                                    |

`encodeMetricEventAsStatsd` is the inverse for `counter`/`gauge`/`set`/`distribution` (one line per
set member or per distribution sample); `histogram` and `summary` have no StatsD representation
and raise `E_STATSD_UNSUPPORTED_METRIC_TYPE`.

## Pattern engine

`patterns/engine.ts` is a small, original named-pattern engine in the spirit of grok, with its own
syntax and an independent implementation (not a port). A pattern mixes literal regular expression
syntax with `%{NAME}` references to other named patterns:

- `%{NAME}` inserts the referenced pattern's expansion as a non-capturing group.
- `%{NAME:field}` additionally captures the match under `field`.
- `%{NAME:field:type}` captures and converts to `int` (`bigint`), `float` (`number`), or
  `timestamp` (parsed as RFC 3339); the default type is `string`.

```ts
const registry = new PatternRegistry(builtinPatterns).define(
  'APP_LINE',
  '%{TIMESTAMP_ISO8601:ts:timestamp} %{LOGLEVEL:level} %{WORD:component}: %{GREEDYDATA:message}',
);
const compiled = registry.compile('%{APP_LINE}');
compiled.decode('2024-06-15T12:00:00Z ERROR db_pool: connection refused'); // → LogEvent
```

A pattern is compiled to a single `RegExp` **once**; matching an input never recompiles.
`builtinPatterns` (`patterns/library.ts`) ships common building blocks (`INT`, `NUMBER`, `WORD`,
`IPV4`, `IPV6` — all nine RFC 5952 textual forms —, `IP`, `HOSTNAME`, `UUID`, `MAC`, `EMAIL`,
`PATH`, `WINDOWS_PATH`, `LOGLEVEL`, `DURATION`, ISO 8601 and Apache-style (`HTTPDATE`) timestamp
fragments) and whole-line formats: `COMMONAPACHELOG`, `COMBINEDAPACHELOG` (Apache/nginx "combined"
log format), `NGINXACCESSLOG`, and `SYSLOGLINE`.

Catastrophic backtracking is guarded against two ways: the built-in patterns are written to avoid
the dangerous shapes (non-greedy `DATA` instead of `GREEDYDATA` wherever two wildcards would
otherwise sit next to each other, and delimiter-bounded repetition like `PATH`'s `/\S*` rather than
nested quantifiers), and `compile()` runs a best-effort static check that rejects a pattern
chaining two unbounded wildcards (`.*`/`.+`) with nothing but pattern-generated grouping between
them — the shape that produces exponential backtracking most often in practice. This is a
heuristic, not a proof: it catches the common case of chaining greedy fragments together, but a
sufficiently creative custom pattern can still be slow, so treat user-supplied patterns as you
would any other regular expression from an untrusted source.

## Kafka wire protocol

`src/kafka/` is a hand-written Kafka client — not a `Decoder`/`Encoder` pair like the rest of this
package (there is no byte frame to decode into events; it is its own request/response protocol
over a persistent connection), so it is not part of `defaultCodecs` and is used directly by name.
It started as `@ferrule/sinks`'s Kafka producer's support code and moved here so a future Kafka
_source_ (a separate package, `@ferrule/sources`, that must not depend on `@ferrule/sinks`) can
reuse it without duplication:

- **`primitives.ts`** — `KafkaWriter`/`KafkaReader`: fixed-width integers, the classic
  length-prefixed string/bytes/array encodings, and the "compact" (unsigned-varint-length-prefixed)
  encodings plus the empty tagged-fields terminator KIP-482 "flexible" API versions use.
- **`record-batch.ts`** — `encodeRecordBatch`/`decodeRecordBatch`: RecordBatch v2 (magic byte `2`),
  CRC-32C verified (`@ferrule/buffer`'s `crc32c`), `none`/`gzip` compression, and the
  transactional/control-batch attribute bits a consumer needs to skip control batches and (under
  `read_committed`) filter aborted-transaction data.
- **`murmur2.ts`** — the classic default partitioner (`murmur2Partition`) and the
  sticky/round-robin strategies for unkeyed records, bit-for-bit compatible with the Java client.
- **`protocol.ts`** — request/response codecs for `ApiVersions`, `Metadata`, `InitProducerId`,
  `Produce`, `SaslHandshake`/`SaslAuthenticate`, and the consumer group APIs: `FindCoordinator`,
  `JoinGroup`, `SyncGroup`, `Heartbeat`, `LeaveGroup`, `OffsetFetch`, `OffsetCommit`, and `Fetch`.
- **`consumer-protocol.ts`** — `ConsumerProtocolSubscription`/`ConsumerProtocolAssignment`: the
  separate, classic-primitives binary schema embedded in `JoinGroup`'s `metadata` and `SyncGroup`'s
  `assignment` fields (opaque to the broker), including `ownedPartitions` (version 1), which the
  cooperative-sticky assignor needs.
- **`assignors.ts`** — `rangeAssignor` (Kafka's classic `RangeAssignor`) and
  `cooperativeStickyAssignor` (KIP-429: sticky, and cooperative — a partition moving between
  members is omitted from both for one generation, so the old owner revokes and rejoins before the
  new owner receives it). Both are pure functions from subscriptions to assignments.
- **`connection.ts`** — `KafkaBrokerConnection`: TCP (optionally TLS, via the small
  `KafkaTlsOptions` shape — this package does not depend on `@ferrule/sinks`'s own TLS option
  schema, even though the two are structurally compatible) and correlation-ID-based request
  pipelining.
- **`sasl.ts`** — SASL/PLAIN and SASL/SCRAM-SHA-256 (reusing this package's own `scram.ts`).
- **`consumer.ts`** — `KafkaConsumer`: the full consumer group client built on everything above.

```ts
const consumer = new KafkaConsumer({
  bootstrapBrokers: [{ host: 'localhost', port: 9092 }],
  groupId: 'my-group',
  topics: ['events'],
  assignor: 'cooperative_sticky', // or 'range' (default)
  autoOffsetReset: 'earliest', // or 'latest'; default 'earliest'
  onRebalance: ({ assigned, revoked }) => {
    /* flush state for `revoked` before it's handed to another member */
  },
});

for (;;) {
  const batches = await consumer.poll(); // PartitionBatch[], one per partition with new records
  for (const batch of batches) {
    /* ...process batch.records... */
  }
  await consumer.commit(
    batches.map((b) => ({
      topic: b.topic,
      partition: b.partition,
      offset: b.records[b.records.length - 1]!.offset + 1n,
    })),
  );
}

await consumer.close(); // sends LeaveGroup so the group rebalances immediately
```

`KafkaConsumer` manages group membership itself: `FindCoordinator` → `JoinGroup` → (the elected
leader runs the configured assignor) → `SyncGroup` → stable, heartbeats on a third of the session
timeout by default, and rejoins on `REBALANCE_IN_PROGRESS` or a lost membership error. It takes its
own minimal `KafkaConsumerClock` (`now()`/`sleep()`), not `@ferrule/runtime`'s `Clock` — this
package must not depend on that higher layer — so a caller with a runtime `Clock` adapts it.

A partition with no committed offset (a fresh group, or one new to that partition), or whose
committed offset the broker reports `OFFSET_OUT_OF_RANGE`, is positioned via `ListOffsets` against
`autoOffsetReset` (`earliest`, the default, or `latest`) rather than assumed to be `0`.
`pausePartitions`/`resumePartitions` exclude specific owned partitions from the next `poll()`'s
`Fetch` without affecting group membership — the mechanism a caller applies its own per-partition
backpressure with (see `@ferrule/sources`'s `kafka` source, below).

`@ferrule/sources`'s `kafka` source (issue #15) wires this into a `SourceDefinition`: its own
option schema, acknowledgement-driven offset commits (only the contiguous prefix of acknowledged
records per partition is ever committed), and per-partition backpressure — see that package's
README for the source itself.

## Codec registry

A uniform interface so a source or sink can pick a codec by name instead of importing modules
directly:

```ts
interface Decoder {
  readonly name: string;
  decode(frame: Uint8Array): Event[]; // throws a typed FerruleError, never anything else
}

interface Encoder {
  readonly name: string;
  encode(event: Event): Uint8Array;
  encodeBatch?(events: readonly Event[]): Uint8Array; // preferred when it exists and you have >1 event
}

interface Codec<DecodeOptions = unknown, EncodeOptions = unknown> {
  readonly name: string;
  createDecoder?(options?: DecodeOptions): Decoder;
  createEncoder?(options?: EncodeOptions): Encoder;
}
```

`decodeFrames(decoder, frames)` decodes a whole batch of frames and collects per-frame errors
instead of aborting the batch on the first bad one:

```ts
const { events, errors } = decodeFrames(decoder, frames);
// errors: { frameIndex: number; error: FerruleError }[]
```

`defaultCodecs` (a `CodecRegistry`) is pre-populated with every codec this package ships:

| Name              | Decode                                             | Encode                                            | Typed options                                                             |
| ----------------- | -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `json`            | one JSON object, or an array of objects, per frame | one `LogEvent`'s fields as JSON                   | `JsonCodecOptions` (wraps core's `JsonParseOptions`/`JsonEncodeOptions`)  |
| `ndjson`          | one JSON object per line/frame (blank frames skip) | same as `json`, one object per frame              | `JsonCodecOptions`                                                        |
| `text`            | the whole frame as `.message`                      | a configurable field (`.message` by default)      | `TextCodecOptions`                                                        |
| `logfmt`          | one logfmt line                                    | one logfmt line                                   | `LogfmtDecodeOptions` / `LogfmtEncodeOptions`                             |
| `csv`             | a whole CSV document → many `LogEvent`s            | `encodeBatch` emits one document with one header  | `CsvLogDecodeOptions` / `CsvLogEncodeOptions & { columns }`               |
| `syslog`          | auto-detected RFC 5424/3164                        | RFC 5424                                          | `SyslogAutoDecodeOptions`                                                 |
| `otlp_protobuf`   | one `Export<Signal>ServiceRequest`                 | one request per event; `encodeBatch` batches many | `{ signal: 'logs' \| 'metrics' \| 'traces' }` + `OtlpDecodeOptions`       |
| `otlp_json`       | OTLP/JSON, one signal                              | same, JSON text                                   | `{ signal }` + `OtlpJsonDecodeOptions`                                    |
| `prometheus_text` | a whole exposition document → many `MetricEvent`s  | `encodeBatch` groups `# TYPE` lines correctly     | `PrometheusDecodeOptions` / `PrometheusEncodeOptions`                     |
| `statsd`          | a whole packet → many `MetricEvent`s               | `encodeBatch` emits one packet                    | `StatsdDecodeOptions`                                                     |
| `pattern`         | one compiled-pattern match per frame               | — (decode-only)                                   | `{ pattern: string; registry?: PatternRegistry } & PatternCompileOptions` |

`otlp_protobuf`/`otlp_json`/`prometheus_text`/`csv`/`statsd` all encode a single event correctly
through `encode`, but batch several events into one request/document/packet more efficiently (and,
for OTLP, more idiomatically) through `encodeBatch` — prefer it when encoding more than one event
at a time. Register your own codec with `CodecRegistry.register` (or build an independent registry
with `new CodecRegistry()`) to extend the set by name.

## Known gaps

- OTLP encoding never reconstructs `Metric.description`/`.unit`, `LogRecord`/`Span` dropped-counts,
  or `Span.flags` — none of them have a home in core's data model.
- Exponential histograms are decode-only; core→OTLP metric encoding always produces a classic
  `Histogram`.
- `set` and `distribution` core metric values cannot be encoded to OTLP or StatsD (no wire
  representation exists in either format) — convert them first.
- The pattern engine's backtracking guard is a heuristic over the built-in library and the
  compiler's own static check, not a hard runtime guarantee for arbitrary custom patterns.
- RFC 3164 has no encoder (the format has no registered structure to encode back into reliably);
  only RFC 5424 round-trips through this package.
- **Kafka**: no KIP-394 two-phase join (a `JoinGroup` from a brand-new member always succeeds on
  the first try rather than requiring `UNKNOWN_MEMBER_ID` once and a retry with the assigned
  member ID — a lenient-broker-compatible simplification); no incremental Fetch sessions (every
  `Fetch` restates its full topic-partition set); no static membership (`group.instance.id`); the
  cooperative-sticky assignor's balancing pass is a greedy repeated max/min swap, exact for the
  common case of every member subscribing to the same topics, not Kafka's precise sticky
  optimizer. Tested against an in-repo fake broker (`packages/codecs/test/kafka/support/`), not a
  real Kafka cluster.
