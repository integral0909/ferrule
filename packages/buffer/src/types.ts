import type { DeliveryStatus, Event } from '@ferrule/core';

/** What a writer does when the buffer has no room for a write. */
export type WhenFull =
  /** `write` waits (respecting its `signal`, if any) until space is available. */
  | 'block'
  /** `write` immediately throws {@link BufferFullError}; the buffer is left unchanged. */
  | 'drop_newest';

/**
 * Controls when written data is made durable (`fsync`ed). Weaker policies are faster but risk
 * losing data that was accepted but not yet flushed if the process crashes; see `FORMAT.md`.
 */
export type SyncPolicy =
  /** `fsync` after every `write` call (or every group of `write` calls issued back to back). */
  | { kind: 'always' }
  /** `fsync` on a fixed timer; writes issued in the same interval share one `fsync` (group commit). */
  | { kind: 'interval'; ms: number }
  /** Never `fsync` explicitly; durability is whatever the OS provides on its own schedule. */
  | { kind: 'none' };

export interface WriteOptions {
  /** Aborts a write that is blocked waiting for space (`whenFull: 'block'`). */
  signal?: AbortSignal;
}

export interface ReadOptions {
  /** Aborts a read that is blocked waiting for data. */
  signal?: AbortSignal;
}

/** A batch of events read from a buffer, ready to be handed to the rest of the pipeline. */
export interface ReadBatch {
  readonly events: readonly Event[];
  /**
   * Explicitly acknowledges every event in this batch (equivalent to calling
   * `event.metadata.finalizers.finish(status)` on each one). Acknowledging an event that has
   * already reached a terminal state is a no-op.
   */
  ackAll(status?: DeliveryStatus): void;
}

/** The write side of a buffer. */
export interface BufferWriter {
  /**
   * Writes `events`. The returned promise resolves once the events are durable per the
   * configured sync policy — at that point the events' own finalizers (if any) are also
   * finished, so an upstream source can safely acknowledge them.
   *
   * If the buffer is full: waits for space when `whenFull` is `'block'` (or rejects if aborted),
   * or throws {@link BufferFullError} immediately when `'drop_newest'`. Either way, the caller
   * keeps ownership of events that were not accepted and is responsible for finalizing them.
   */
  write(events: readonly Event[], options?: WriteOptions): Promise<void>;
  /** Forces any batched sync to happen now and waits for it. A no-op if nothing is pending. */
  flush(): Promise<void>;
  /** Flushes and closes the writer. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

/** The read side of a buffer. */
export interface BufferReader {
  /**
   * Reads up to `maxEvents`. Waits for at least one event to become available; resolves with an
   * empty batch once the reader is closed (or the writer closed and everything has been read).
   * Each returned event carries a fresh finalizer (in addition to any it already had) whose
   * completion acknowledges it to the buffer; see {@link ReadBatch.ackAll} for explicit acking.
   */
  read(maxEvents: number, options?: ReadOptions): Promise<ReadBatch>;
  close(): Promise<void>;
  readonly closed: boolean;
}

/** A paired writer and reader over the same underlying buffer. */
export interface BufferHandle {
  readonly writer: BufferWriter;
  readonly reader: BufferReader;
}

/** Reason a record could not be recovered when a buffer was opened; see `FORMAT.md`. */
export type CorruptRecordKind = 'truncated-tail' | 'bad-length' | 'bad-checksum';

/**
 * Observes buffer activity for metrics reporting. Every method is optional and called
 * synchronously; implementations should not block or throw.
 */
export interface BufferMetricsObserver {
  onWrite?(events: number, bytes: number): void;
  onRead?(events: number, bytes: number): void;
  onAck?(events: number, bytes: number): void;
  onDropNewest?(events: number, bytes: number): void;
  onSegmentCreated?(segmentId: bigint): void;
  onSegmentDeleted?(segmentId: bigint): void;
  onCorruptRecord?(kind: CorruptRecordKind, segmentId: bigint): void;
  onWriterWaitMs?(ms: number): void;
  onSizeChanged?(bytes: number, events: number, segments: number): void;
}
