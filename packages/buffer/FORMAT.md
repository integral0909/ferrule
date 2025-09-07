# Binary formats

This document describes every on-disk and on-wire binary format `@ferrule/buffer` defines: the
event codec, CRC-32C, the segment file layout, the ledger (checkpoint) file, and the recovery
algorithm that ties them together. All multi-byte integers are little-endian unless stated
otherwise. All formats are versioned with a single version byte so a future incompatible change
can be detected and rejected cleanly rather than misread.

## 1. Event codec (`codec.ts`)

`encodeEvent`/`decodeEvent` and their batch forms (`encodeEventBatch`/`decodeEventBatch`) convert
a `@ferrule/core` `Event` (a `LogEvent`, `MetricEvent`, or `SpanEvent`) to and from a compact
binary form. This is the payload stored in every WAL record, and is also the format events use to
cross a `worker_threads` boundary (see `docs/architecture.md` §4.3).

### 1.1 Primitives

- **varint**: unsigned LEB128. 7 payload bits per byte, high bit set means "more bytes follow".
  Used for lengths, counts, and (after zigzag mapping) signed integers.
- **zigzag**: maps a signed integer to an unsigned one so small magnitudes stay compact regardless
  of sign: `0, -1, 1, -2, 2, ... -> 0, 1, 2, 3, 4, ...`. Applied to `bigint`s before varint-encoding
  them (integer values and every timestamp, which is nanoseconds since the epoch as an `int64`).
- **length-prefixed bytes**: a varint length followed by that many raw bytes.
- **string**: a length-prefixed UTF-8 byte sequence.
- **optional field**: one byte (`0` absent, `1` present) followed by the value if present.

### 1.2 Value encoding

Every `Value` (see `@ferrule/core`) is encoded as a one-byte tag followed by a tag-specific body:

| Tag | Kind        | Body                                                                    |
| --- | ----------- | ----------------------------------------------------------------------- |
| 0   | `null`      | (none)                                                                  |
| 1   | `false`     | (none)                                                                  |
| 2   | `true`      | (none)                                                                  |
| 3   | `integer`   | zigzag varint (`bigint`, int64)                                         |
| 4   | `float`     | 8-byte IEEE-754 float64                                                 |
| 5   | `string`    | length-prefixed UTF-8                                                   |
| 6   | `bytes`     | length-prefixed raw bytes                                               |
| 7   | `timestamp` | zigzag varint nanoseconds since the epoch                               |
| 8   | `array`     | varint count, then that many values                                     |
| 9   | `object`    | varint count, then that many (string key, value) pairs, insertion order |

Arrays and objects recurse through the same value encoding; decoding tracks nesting depth and
rejects input past `DecodeLimits.maxDepth` (default 64).

An object's fields, a span's attributes/resource, and a metric's tags are written using the
_body_ of tags 8/9 directly (count + entries) wherever the kind is statically known, saving the
leading tag byte.

### 1.3 Event envelope

```
u8       format version (currently 1)
u8       event kind: 0 = log, 1 = metric, 2 = span
         -- metadata --
opt<str> sourceId
opt<str> sourceType
zigzag   receivedAt (nanoseconds since the epoch)
         -- kind-specific body (see below) --
```

**Metadata deliberately excludes finalizers.** `EventMetadata.finalizers` are live JavaScript
objects (promises, callbacks) tied to a specific process's in-flight delivery tracking; they have
no meaningful serialized form and are not needed to resume delivery after a restart. When an
event is written to the disk buffer, its _original_ finalizers are finished (`'delivered'`) once
the write is durable — the buffer itself has taken responsibility for the event from that point.
When an event is later read back out, it receives a **fresh** finalizer (see §4) whose completion
drives the buffer's own acknowledgement bookkeeping; it is unrelated to whatever finalizer the
event carried before being persisted.

**`LogEvent` body:** the object body (§1.2) of `fields`, directly.

**`MetricEvent` body:**

```
str            series.name
opt<str>       series.namespace
varint         tags.size
(str, str)*    tags entries
u8             metric kind: 0 = incremental, 1 = absolute
<metric value> (§1.4)
opt<zigzag>    timestamp (nanoseconds since the epoch)
opt<f64>       intervalMs
```

**`SpanEvent` body:**

```
bytes[16]      traceId (fixed width; SpanEvent's constructor guarantees this length)
bytes[8]       spanId (fixed width)
opt<bytes[8]>  parentSpanId
opt<str>       traceState
str            name
u8             spanKind: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer
zigzag         startTime (nanoseconds)
zigzag         endTime (nanoseconds)
u8             status.code: 0 unset, 1 ok, 2 error
opt<str>       status.message
<object>       attributes
varint         annotations.length
(str name, zigzag time, <object> attributes)*   annotations
varint         links.length
(bytes traceId, bytes spanId, opt<str> traceState, <object> attributes)*  links
<object>       resource
opt<1 + str name + opt<str> version + <object> attributes>  scope
```

Link trace/span IDs are length-prefixed (unlike the top-level trace/span IDs) because
`SpanLink.traceId`/`spanId` are not constructor-validated to a fixed width.

### 1.4 Metric value encoding

One tag byte, then a type-specific body:

| Tag | Type           | Body                                                                             |
| --- | -------------- | -------------------------------------------------------------------------------- |
| 0   | `counter`      | f64 value                                                                        |
| 1   | `gauge`        | f64 value                                                                        |
| 2   | `set`          | varint count, then that many strings                                             |
| 3   | `distribution` | u8 statistic (0 histogram, 1 summary), varint count, then (f64 value, f64 rate)* |
| 4   | `histogram`    | varint bucket count, then (f64 upperLimit, f64 count)*, then f64 count, f64 sum  |
| 5   | `summary`      | varint count, then (f64 quantile, f64 value)*, then f64 count, f64 sum           |

### 1.5 Batch form

`encodeEventBatch`/`decodeEventBatch` share one envelope for several events:

```
u8      format version
varint  event count
<event body>*   (kind byte + metadata + kind-specific body, per event — no per-event version byte
                 or length prefix; a corrupt batch fails the whole decode, which is acceptable for
                 a same-process channel such as a worker_threads message)
```

### 1.6 Bounded decoding

Every decode path is bounded by `DecodeLimits` (`maxDepth`, `maxStringBytes`, `maxBytesLength`,
`maxCollectionLength`), and every declared count or length is checked against the relevant limit
_before_ any loop iterates or allocates — a corrupt or hostile count never causes an unbounded
allocation or loop; the first read that runs out of real bytes fails immediately with a typed
error. `decodeEvent`/`decodeEventBatch` wrap the whole decode in a handler that converts any
unexpected exception (for example a `DOMException` from strict UTF-8 decoding) into a
`CodecMalformedError`, so arbitrary input never throws anything but a `FerruleError` subclass.

## 2. CRC-32C (`crc32c.ts`)

A hand-written, table-driven implementation of CRC-32C (Castagnoli): reflected polynomial
`0x82F63B78` (normal form `0x1EDC6F41`), the same polynomial used by iSCSI, ext4, and Btrfs, chosen
for better burst-error detection than the classic CRC-32 (Ethernet/zlib) polynomial. `crc32c(data,
seed)` can be chained — `crc32c(b, crc32c(a))` equals `crc32c(concat(a, b))` — which the segment
and ledger formats use to checksum multiple fields without concatenating them first.

## 3. Segment files (`segment.ts`)

A **segment** is one file in the buffer directory holding a run of records. Segments are named
`NNNNNNNNNNNNNNNNNNNN.seg` — a 20-digit, zero-padded, monotonically increasing decimal segment id
(20 digits comfortably covers the full `uint64` range), so a directory listing sorted
lexicographically is also sorted by id.

### 3.1 Segment header (8 bytes, at offset 0)

```
bytes[4]  magic: "FRB1" (0x46 0x52 0x42 0x31)
u8        format version (currently 1)
bytes[3]  reserved (zero)
```

### 3.2 Record framing

Every record after the header uses a fixed 16-byte frame header followed by its payload:

```
u32  length        -- byte length of payload
u64  seq           -- monotonically increasing sequence number, unique within one buffer directory
u32  crc32c        -- checksum of [length(4) ++ seq(8) ++ payload], all as written on disk
byte payload[length] -- the codec-encoded event (§1)
```

`length` and `seq` are covered by the checksum (not just the payload) so that corruption of the
framing itself — not only the payload — is detected.

Records are **never modified or overwritten** after being written: the WAL is append-only within
a segment. A segment only shrinks via truncation of a torn tail (recovery) or is deleted whole
once every record in it has been acknowledged (§5).

### 3.3 Segment rollover

A segment accepts new records until appending one would push it past `maxSegmentBytes` (and it
already has at least one record — a segment is never rejected as "too small" for its first
record even if that single record is large). At that point:

1. The outgoing segment is `fsync`ed and closed. This means **every segment except the current
   tail is always fully durable** — recovery only needs to deeply validate the tail (§5), not
   scan every sealed segment for torn writes.
2. A new segment file is created (`open` with create-exclusive semantics), its 8-byte header is
   written and `fsync`ed.
3. The buffer directory itself is `fsync`ed, so the new segment's directory entry — not just its
   contents — survives a crash. Without this step a crash could leave a file whose data was
   `fsync`ed but whose _name_ never became durable, silently losing anything routed to it.

## 4. Acknowledgement and record identity

Each record's `seq` is assigned by the writer in strictly increasing order as records are
appended (across rollover too — sequence numbers are global to the buffer directory, not
per-segment). When a reader reads records out, each event it returns carries a **fresh
finalizer** (`EventFinalizer`, from a dedicated single-event `BatchNotifier`) in addition to
whatever finalizers it already had; finishing that finalizer — with any terminal status — is what
acknowledges the record to the buffer. This is deliberately decoupled from _delivery success_: the
buffer's job ends once a downstream component has taken ownership of the event, not once that
component's own retries eventually succeed or give up.

Acknowledgements can arrive **out of order** relative to read order (a fan-out or a concurrent
sink can finish events in any order). The reader keeps the read-but-unacknowledged records in a
FIFO queue and an out-of-order set of acknowledged sequence numbers; after every acknowledgement
it pops the contiguous prefix of the FIFO whose sequence numbers are in the acknowledged set,
advancing the durable checkpoint only over that contiguous prefix. A record acknowledged out of
turn does not advance the checkpoint until every record before it is also acknowledged — this is
what makes the checkpoint safe to persist and resume from.

## 5. The ledger (`ledger.ts`)

The ledger is a small, fixed-size file recording the durable checkpoint: the position such that
every record before it, across every segment, has been acknowledged. Segments entirely before the
checkpoint's segment are deleted; the checkpoint segment and any after it are kept.

### 5.1 Layout (32 bytes)

```
bytes[4]  magic: "FRLG"
u8        format version (currently 1)
bytes[3]  reserved (zero)
u64       ackedSegmentId
u32       ackedOffset
u64       ackedSeq       -- sequence number of the last acknowledged record (a consistency check)
u32       crc32c         -- over every preceding byte
```

### 5.2 Atomic write protocol

The ledger is never modified in place. Every update:

1. writes the full new content to `ledger.tmp`,
2. `fsync`s `ledger.tmp`,
3. renames `ledger.tmp` to `ledger` (atomic on every platform this targets),
4. `fsync`s the buffer directory, so the rename itself is durable.

If a crash happens before step 4, the rename might not survive; recovery then falls back to the
_previous_ `ledger` file (still valid, from before this update — a rename never destroys the old
name's data on any of these platforms until it is itself durable) or, if none exists yet, to "the
start of the oldest segment on disk" (§6). Either fallback is safe: it can only cause **redelivery
of already-processed records**, never loss, which matches the at-least-once contract in
`docs/architecture.md` §2.3.

### 5.3 Durability clamping

The ledger's `ackedOffset` is never allowed to reference a position past what has actually been
`fsync`ed. This matters when the sync policy is `'interval'` or `'none'`: a reader can observe and
acknowledge a record the moment it is appended, before the writer's next scheduled `fsync`. If the
process crashed at that instant, that acknowledgement was never durable, so persisting it would be
unsound — recovery could resume _past_ data that no longer exists after the tail is truncated.
Before every ledger write, the buffer clamps the offset it is about to persist to the tail
segment's last known `fsync`ed length (sealed segments need no clamping: §3.3 guarantees they are
always fully durable). The in-memory bookkeeping (and segment deletion) still uses the true,
unclamped position — only the _persisted_ value is clamped, so a crash under a weak sync policy
loses at most the acknowledgements made since the last `fsync`, and the buffer catches up again
once that `fsync` runs.

## 6. Recovery algorithm (`recovery.ts`)

Run once, synchronously with respect to everything else, when `DiskBuffer.open` is called:

1. Create the buffer directory if it does not exist.
2. List and sort every `NNN....seg` file by id. If there are none, create segment `0` (write its
   header, `fsync` it, `fsync` the directory) and stop here — an empty, fresh buffer.
3. For every segment, **oldest to newest**:
   - Read the whole file and validate its header.
   - Scan records from offset 8 forward using the non-throwing record scanner (§3.2). Each result
     is one of: **ok** (advance past it, track the highest `seq` seen), **clean end of file**
     (nothing left; stop), or a **corruption result** (`truncated`, `bad-length`, or
     `bad-checksum`).
   - **For the last (tail) segment**, any corruption result means: truncate the file to the
     offset where the good data ends, `fsync`, and stop scanning this segment. This is
     unconditional — regardless of the configured `corruption` policy — because a torn tail write
     is expected, routine behavior of a WAL, not something an operator opts in or out of.
   - **For every earlier (sealed) segment**, a corruption result is unexpected (sealed segments
     are always fully `fsync`ed — see §3.3) and is handled per the `corruption` option:
     - `'stop'`: recovery throws `SegmentCorruptError` and `open` fails.
     - `'skip'` (default): the record is counted and reported via
       `BufferMetricsObserver.onCorruptRecord`. If the reason was `bad-checksum`, the frame's
       length is still trustworthy, so the scan skips exactly past it and resumes — a single bad
       record does not lose the rest of the segment. If the reason was `bad-length` (or a
       structurally invalid header), the length field itself may be corrupt, so there is no safe
       way to resynchronize; the scan stops for that segment (the file itself is left untouched —
       only the tail is ever truncated) and moves on to the next segment.
4. Read the ledger (§5). If it is missing or corrupt, or references a segment no longer present,
   fall back to the oldest segment still on disk, at its first record. Otherwise use it, clamped
   so its offset never exceeds that segment's now-validated size.
5. Delete any segment strictly before the recovered checkpoint's segment — these were fully
   acknowledged before whatever crash interrupted the previous process, but the deletion itself
   might not have completed (segment deletion always happens _after_ the ledger write that makes
   it safe, so this is exactly the set of segments a previous run got partway through deleting).
6. The reader resumes exactly at the recovered checkpoint. Anything read but not yet acknowledged
   before the crash is redelivered — correct at-least-once behavior. The writer resumes appending
   after the highest sequence number found anywhere on disk.

This tolerates a crash at **any** point: mid-record-write, mid-`fsync`, mid-rollover, mid-ledger-
write, mid-rename, or between any of these steps and the next — every one of those points is
covered by a durability boundary described above (§3.3, §5.2, §5.3) that this algorithm relies on.
