# @ferrule/buffer

Crash-safe disk buffering and the binary event codec for Ferrule. See `docs/architecture.md` §4.4
for how this fits into the runtime, and `FORMAT.md` for the exact on-disk and on-wire byte
layouts.

This package provides:

- A **binary event codec** (`encodeEvent`/`decodeEvent`, plus batch forms) — a compact, versioned,
  bounded-decode encoding for every `@ferrule/core` `Event`. Used both for persistence and to pass
  events across a `worker_threads` boundary.
- **CRC-32C**, hand-written and table-driven.
- A **segmented write-ahead-log disk buffer** (`DiskBuffer`) with crash recovery, out-of-order
  acknowledgement tracking, segment rollover and deletion, configurable sync policy and
  backpressure, and metrics hooks.
- An in-memory buffer (`createMemoryBuffer`) with the identical reader/writer interface, so a
  runtime can swap between memory and disk buffering without touching call sites.
- A `FileSystem` abstraction with a `NodeFileSystem` implementation and an in-memory
  `InMemoryFileSystem` that can simulate crashes and inject faults, which is what makes the
  crash-safety tests possible.

Node.js standard library only — no runtime dependencies.

## Quick start

```ts
import { LogEvent } from '@ferrule/core';
import { DiskBuffer } from '@ferrule/buffer';

const { writer, reader } = await DiskBuffer.open('/var/lib/ferrule/buffers/my-sink', {
  maxSegmentBytes: 64 * 1024 * 1024,
  maxBufferBytes: 1024 * 1024 * 1024,
  sync: { kind: 'interval', ms: 100 },
  whenFull: 'block',
});

// Producer side (e.g. a source):
await writer.write([LogEvent.fromMessage('hello')]);

// Consumer side (e.g. a sink adapter):
const batch = await reader.read(256);
for (const event of batch.events) {
  await deliver(event);
  event.metadata.finalizers.finish('delivered'); // acknowledges the record to the buffer
}
```

Swapping in a memory buffer (same shape, no persistence, no crash recovery):

```ts
import { createMemoryBuffer } from '@ferrule/buffer';

const { writer, reader } = createMemoryBuffer({ maxEvents: 10_000, maxBytes: 64 * 1024 * 1024 });
```

## Public API

### Codec

- `encodeEvent(event: Event): Uint8Array`
- `decodeEvent(bytes: Uint8Array, limits?: DecodeLimits): Event`
- `encodeEventBatch(events: readonly Event[]): Uint8Array`
- `decodeEventBatch(bytes: Uint8Array, limits?: DecodeLimits): Event[]`

`DecodeLimits` bounds nesting depth, string/byte lengths, and collection sizes for untrusted
input; every decode failure is a `FerruleError` subclass (`CodecTruncatedError`,
`CodecMalformedError`, `CodecLimitExceededError`, `CodecVersionError`).

### CRC-32C

- `crc32c(data: Uint8Array, seed?: number): number`

### Buffers

Both buffer kinds share:

```ts
interface BufferWriter {
  write(events: readonly Event[], options?: WriteOptions): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
}

interface BufferReader {
  read(maxEvents: number, options?: ReadOptions): Promise<ReadBatch>;
  close(): Promise<void>;
  readonly closed: boolean;
}

interface ReadBatch {
  readonly events: readonly Event[];
  ackAll(status?: DeliveryStatus): void;
}
```

- `DiskBuffer.open(dir: string, options?: DiskBufferOptions): Promise<DiskBufferHandle>` —
  `DiskBufferHandle` adds `close()` (closes both sides) and `drain()` (resolves once every
  written event has been acknowledged).
- `createMemoryBuffer(options?: MemoryBufferOptions): BufferHandle`

Key `DiskBufferOptions`: `fs`, `maxSegmentBytes`, `maxBufferBytes`, `maxRecordBytes`, `whenFull`
(`'block' | 'drop_newest'`), `sync` (`{ kind: 'always' } | { kind: 'interval'; ms: number } | {
kind: 'none' }`), `corruption` (`'skip' | 'stop'`), `metrics`, `signal`.

### Filesystem

- `interface FileSystem` / `interface FileHandle` — see `filesystem.ts`.
- `class NodeFileSystem implements FileSystem` — the production implementation.
- `class InMemoryFileSystem implements FileSystem` — for tests. `injectFault(rule)` fails a
  specific operation; `crash(options)` simulates power loss: every write not followed by `fsync`
  is dropped (or torn at a random byte, with `mode: 'tear'`), and every directory-entry change
  not followed by `fsyncDir` is reverted.

### Metrics

`BufferMetricsObserver` (all methods optional): `onWrite`, `onRead`, `onAck`, `onDropNewest`,
`onSegmentCreated`, `onSegmentDeleted`, `onCorruptRecord`, `onWriterWaitMs`, `onSizeChanged`.

## Design notes

- **Acknowledgement, not delivery, ends the buffer's responsibility.** A record's fresh finalizer
  (added when it is read) is finished when a downstream component reaches _any_ terminal status
  for it — not only success. The buffer's contract is "this event safely left the buffer," not
  "this event was ultimately delivered"; retrying failed deliveries is the runtime's job.
- **Out-of-order acknowledgement is normal, not an edge case.** Fan-out and concurrent sinks
  finish events in whatever order they finish in. The durable checkpoint only ever advances over
  a contiguous acknowledged prefix (`FORMAT.md` §4), so a record can never be considered durable-
  acknowledged while an earlier one is not.
- **Sealed segments are always fully synced.** Rollover forces an `fsync` of the outgoing segment
  before starting a new one, so recovery only ever needs to deeply validate the current tail.
- **The `corruption` option is about unexpected mid-file corruption**, not the tail's routine torn
  write. A torn tail is always silently truncated regardless of this setting; `'stop'` vs `'skip'`
  only governs what happens if an already-sealed (previously fully synced) segment turns out to
  contain a bad record — something that should only happen via out-of-band disk corruption.

## Known limitations

- Recovery reads every segment's full contents into memory to validate it, not only the tail.
  This is more thorough (it can catch mid-file corruption in old segments, as required) but is
  `O(total buffer size)` rather than `O(tail segment size)`; for very large buffers this makes
  `DiskBuffer.open` proportionally slower. A future version could trust sealed segments by default
  and make full-buffer scrubbing opt-in.
- Writes are fully serialized per `DiskBuffer` (one write's space-wait, append, and sync all
  complete before the next write starts). This keeps the implementation's concurrency reasoning
  simple and still batches multiple events sharing one `write()` call into one sync, but it does
  not pipeline _separate_ concurrent `write()` calls the way a fully general group-commit
  scheduler could.
- `InMemoryFileSystem`'s crash model tracks durability per file and per directory entry, not as a
  single global write-ordered journal. For the access patterns this package's own code uses
  (same-directory renames, append-only segment writes) this is fully faithful; a directly-driven
  cross-directory rename followed by a crash is a documented simplification (see the doc comment
  on `InMemoryFileSystem`).
