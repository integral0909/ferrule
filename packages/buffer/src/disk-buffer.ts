import { join } from 'node:path';
import { BatchNotifier, type DeliveryStatus, type Event } from '@ferrule/core';
import { decodeEvent, encodeEvent } from './codec.js';
import {
  BufferClosedError,
  BufferFullError,
  RecordTooLargeError,
  SegmentCorruptError,
} from './errors.js';
import type { FileHandle, FileSystem } from './filesystem.js';
import { writeLedger } from './ledger.js';
import { NodeFileSystem } from './node-filesystem.js';
import { recoverBuffer, type RecoveredSegment } from './recovery.js';
import {
  encodeRecord,
  encodeSegmentHeader,
  readRecord,
  RECORD_HEADER_SIZE,
  scanRecord,
  segmentFileName,
  SEGMENT_HEADER_SIZE,
} from './segment.js';
import type {
  BufferHandle,
  BufferMetricsObserver,
  BufferReader,
  BufferWriter,
  ReadBatch,
  ReadOptions,
  SyncPolicy,
  WhenFull,
  WriteOptions,
} from './types.js';
import { wakeAll, waitFor, type Waiter } from './waiters.js';

/** Options for {@link DiskBuffer.open}. Every field has a documented, production-safe default. */
export interface DiskBufferOptions {
  /** Defaults to a {@link NodeFileSystem}. Tests substitute an `InMemoryFileSystem`. */
  fs?: FileSystem;
  /** Segments roll over once they reach this size. Default 64 MiB. */
  maxSegmentBytes?: number;
  /** Total on-disk size cap across every segment; writers respect `whenFull` once reached. Default 1 GiB. */
  maxBufferBytes?: number;
  /** Maximum encoded size of a single event. Default 16 MiB. */
  maxRecordBytes?: number;
  /** What `write` does when the buffer is at `maxBufferBytes`. Default `'block'`. */
  whenFull?: WhenFull;
  /** Default `{ kind: 'always' }`. */
  sync?: SyncPolicy;
  /** How to handle a corrupt record found mid-file in an already-sealed segment. Default `'skip'`. */
  corruption?: 'skip' | 'stop';
  metrics?: BufferMetricsObserver;
  /** Aborting closes the buffer (best-effort; in-flight operations reject). */
  signal?: AbortSignal;
}

const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** A {@link BufferHandle} with disk-buffer-specific lifecycle controls. */
export interface DiskBufferHandle extends BufferHandle {
  /** Closes both the writer and the reader, flushing any pending sync first. Idempotent. */
  close(): Promise<void>;
  /** Resolves once every event written so far has been acknowledged. */
  drain(): Promise<void>;
}

interface RecordRef {
  segmentId: bigint;
  offset: number;
  frameEnd: number;
  seq: bigint;
  size: number;
}

/**
 * A crash-safe, segmented write-ahead-log disk buffer. See `FORMAT.md` for the on-disk layout
 * and recovery algorithm. Construct with {@link DiskBuffer.open}.
 */
export class DiskBuffer {
  private readonly fs: FileSystem;
  private readonly dir: string;
  private readonly maxSegmentBytes: number;
  private readonly maxBufferBytes: number;
  private readonly maxRecordBytes: number;
  private readonly whenFull: WhenFull;
  private readonly syncPolicy: SyncPolicy;
  private readonly corruption: 'skip' | 'stop';
  private readonly metrics: BufferMetricsObserver | undefined;

  private segments: RecoveredSegment[];
  private tailHandle: FileHandle;
  private nextSeq: bigint;
  private totalBytes = 0;
  private bufferedEvents = 0;
  private tailDurableLength: number;

  private ackedSegmentId: bigint;
  private ackedOffset: number;
  private ackedSeq: bigint;

  private readSegmentId: bigint;
  private readOffset: number;

  private readonly outstanding: RecordRef[] = [];
  private readonly ackedSeqSet = new Set<bigint>();

  private writerClosed = false;
  private readerClosed = false;
  private aborted = false;

  private readonly writerWaiters: Waiter[] = [];
  private readonly readerWaiters: Waiter[] = [];
  private readonly drainWaiters: Array<() => void> = [];

  private writeChain: Promise<void> = Promise.resolve();
  private readChain: Promise<void> = Promise.resolve();
  private ledgerDirty = false;
  private ledgerWriteInFlight: Promise<void> | undefined;

  private syncWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private syncTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(init: {
    fs: FileSystem;
    dir: string;
    maxSegmentBytes: number;
    maxBufferBytes: number;
    maxRecordBytes: number;
    whenFull: WhenFull;
    syncPolicy: SyncPolicy;
    corruption: 'skip' | 'stop';
    metrics: BufferMetricsObserver | undefined;
    segments: RecoveredSegment[];
    tailHandle: FileHandle;
    nextSeq: bigint;
    ackedSegmentId: bigint;
    ackedOffset: number;
    ackedSeq: bigint;
    readSegmentId: bigint;
    readOffset: number;
  }) {
    this.fs = init.fs;
    this.dir = init.dir;
    this.maxSegmentBytes = init.maxSegmentBytes;
    this.maxBufferBytes = init.maxBufferBytes;
    this.maxRecordBytes = init.maxRecordBytes;
    this.whenFull = init.whenFull;
    this.syncPolicy = init.syncPolicy;
    this.corruption = init.corruption;
    this.metrics = init.metrics;
    this.segments = init.segments;
    this.tailHandle = init.tailHandle;
    this.nextSeq = init.nextSeq;
    this.ackedSegmentId = init.ackedSegmentId;
    this.ackedOffset = init.ackedOffset;
    this.ackedSeq = init.ackedSeq;
    this.readSegmentId = init.readSegmentId;
    this.readOffset = init.readOffset;
    this.tailDurableLength = this.tailSegment.sizeOnDisk;
    for (const s of this.segments) this.totalBytes += s.sizeOnDisk;
  }

  /**
   * Opens (creating if necessary) a segmented disk buffer rooted at `dir`, recovering from any
   * previous crash first. See `FORMAT.md` for the recovery algorithm.
   */
  static async open(dir: string, options: DiskBufferOptions = {}): Promise<DiskBufferHandle> {
    const fs = options.fs ?? new NodeFileSystem();
    const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    const corruption = options.corruption ?? 'skip';
    const metrics = options.metrics;

    const recovered = await recoverBuffer({
      fs,
      dir,
      maxRecordBytes,
      corruption,
      ...(metrics !== undefined ? { metrics } : {}),
    });
    const tailId = recovered.segments[recovered.segments.length - 1]!.id;
    const tailHandle = await fs.open(join(dir, segmentFileName(tailId)), 'read-write');

    const core = new DiskBuffer({
      fs,
      dir,
      maxSegmentBytes,
      maxBufferBytes,
      maxRecordBytes,
      whenFull: options.whenFull ?? 'block',
      syncPolicy: options.sync ?? { kind: 'always' },
      corruption,
      metrics,
      segments: recovered.segments,
      tailHandle,
      nextSeq: recovered.nextSeq,
      ackedSegmentId: recovered.ackedSegmentId,
      ackedOffset: recovered.ackedOffset,
      ackedSeq: recovered.ackedSeq,
      readSegmentId: recovered.readSegmentId,
      readOffset: recovered.readOffset,
    });
    core.reportSize();

    if (options.signal !== undefined) {
      if (options.signal.aborted) void core.abort();
      else options.signal.addEventListener('abort', () => void core.abort(), { once: true });
    }

    const writer: BufferWriter = {
      get closed() {
        return core.writerClosed;
      },
      write: (events, writeOptions) => core.write(events, writeOptions ?? {}),
      flush: () => core.flush(),
      close: () => core.closeWriter(),
    };
    const reader: BufferReader = {
      get closed() {
        return core.readerClosed;
      },
      read: (maxEvents, readOptions) => core.read(maxEvents, readOptions ?? {}),
      close: () => core.closeReader(),
    };

    return {
      writer,
      reader,
      close: () => core.closeAll(),
      drain: () => core.drain(),
    };
  }

  private get tailSegment(): RecoveredSegment {
    return this.segments[this.segments.length - 1]!;
  }

  private reportSize(): void {
    this.metrics?.onSizeChanged?.(this.totalBytes, this.bufferedEvents, this.segments.length);
  }

  // --- Writing -------------------------------------------------------------------------------

  // Never throws synchronously: every failure — including upfront validation — surfaces as a
  // rejected promise, per the BufferWriter contract.
  private write(events: readonly Event[], options: WriteOptions): Promise<void> {
    if (this.writerClosed || this.aborted) return Promise.reject(new BufferClosedError());
    if (events.length === 0) return Promise.resolve();

    const payloads: Uint8Array[] = [];
    for (const event of events) {
      const payload = encodeEvent(event);
      if (payload.byteLength > this.maxRecordBytes) {
        return Promise.reject(new RecordTooLargeError(payload.byteLength, this.maxRecordBytes));
      }
      payloads.push(payload);
    }
    return this.enqueueWrite(events, payloads, options);
  }

  private enqueueWrite(
    events: readonly Event[],
    payloads: Uint8Array[],
    options: WriteOptions,
  ): Promise<void> {
    const totalFrameBytes = payloads.reduce((sum, p) => sum + RECORD_HEADER_SIZE + p.byteLength, 0);

    // The whole operation — including the wait for space — is serialized through `writeChain`,
    // so concurrent `write` calls never race on segment/rollover bookkeeping, and space checked
    // just before appending is never stale by the time bytes are actually written.
    const run = async (): Promise<void> => {
      const waitStarted = Date.now();
      let waited = false;
      while (true) {
        if (this.writerClosed || this.aborted) throw new BufferClosedError();
        if (this.totalBytes + totalFrameBytes <= this.maxBufferBytes) break;
        if (this.whenFull === 'drop_newest') {
          this.metrics?.onDropNewest?.(events.length, totalFrameBytes);
          throw new BufferFullError(
            `disk buffer is full: ${this.totalBytes}/${this.maxBufferBytes} bytes`,
          );
        }
        waited = true;
        await waitFor(this.writerWaiters, options.signal);
      }
      if (waited) this.metrics?.onWriterWaitMs?.(Date.now() - waitStarted);

      for (const payload of payloads) {
        await this.appendRecord(payload);
      }
      await this.awaitDurability();
      this.bufferedEvents += events.length;
      this.metrics?.onWrite?.(events.length, totalFrameBytes);
      this.reportSize();
      wakeAll(this.readerWaiters);
      for (const event of events) event.metadata.finalizers.finish('delivered');
    };

    const result = this.writeChain.then(run, run);
    this.writeChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async appendRecord(payload: Uint8Array): Promise<void> {
    const frameSize = RECORD_HEADER_SIZE + payload.byteLength;
    if (
      this.tailSegment.sizeOnDisk > SEGMENT_HEADER_SIZE &&
      this.tailSegment.sizeOnDisk + frameSize > this.maxSegmentBytes
    ) {
      await this.rollover();
    }
    const seq = this.nextSeq;
    this.nextSeq += 1n;
    const frame = encodeRecord(seq, payload);
    await this.tailHandle.write(frame, this.tailSegment.sizeOnDisk);
    this.tailSegment.sizeOnDisk += frame.byteLength;
    this.totalBytes += frame.byteLength;
  }

  private async rollover(): Promise<void> {
    await this.tailHandle.fsync();
    await this.tailHandle.close();
    const newId = this.tailSegment.id + 1n;
    const path = join(this.dir, segmentFileName(newId));
    const handle = await this.fs.open(path, 'create-new');
    const header = encodeSegmentHeader();
    await handle.write(header, 0);
    await handle.fsync();
    await this.fs.fsyncDir(this.dir);
    this.segments.push({ id: newId, sizeOnDisk: header.byteLength });
    this.totalBytes += header.byteLength;
    this.tailHandle = handle;
    this.tailDurableLength = header.byteLength;
    this.metrics?.onSegmentCreated?.(newId);
  }

  private async awaitDurability(): Promise<void> {
    const policy = this.syncPolicy;
    switch (policy.kind) {
      case 'none':
        return;
      case 'always':
        await this.doSync();
        return;
      case 'interval': {
        await new Promise<void>((resolve, reject) => {
          this.syncWaiters.push({ resolve, reject });
          this.ensureSyncTimer(policy.ms);
        });
        return;
      }
    }
  }

  private ensureSyncTimer(ms: number): void {
    if (this.syncTimer !== undefined) return;
    this.syncTimer = setInterval(
      () => {
        void this.flushSyncWaiters();
      },
      Math.max(1, ms),
    );
    this.syncTimer.unref();
  }

  private async flushSyncWaiters(): Promise<void> {
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    if (this.syncTimer !== undefined) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    try {
      await this.doSync();
      for (const w of waiters) w.resolve();
    } catch (error) {
      for (const w of waiters) w.reject(error);
    }
  }

  private async doSync(): Promise<void> {
    await this.tailHandle.fsync();
    this.tailDurableLength = this.tailSegment.sizeOnDisk;
  }

  private async flush(): Promise<void> {
    if (this.syncWaiters.length > 0) await this.flushSyncWaiters();
    else if (this.tailDurableLength < this.tailSegment.sizeOnDisk) await this.doSync();
    await this.ledgerWriteInFlight;
  }

  // --- Reading -------------------------------------------------------------------------------

  // Never throws synchronously; see the note on `write`.
  private read(maxEvents: number, options: ReadOptions): Promise<ReadBatch> {
    if (maxEvents <= 0) return Promise.reject(new RangeError('maxEvents must be positive'));
    // Serialized so two concurrent `read` calls never interleave their cursor advancement.
    const run = async (): Promise<ReadBatch> => {
      while (true) {
        const { events, refs } = await this.readAvailable(maxEvents);
        if (events.length > 0) return this.buildBatch(events, refs);
        if (this.readerClosed || this.aborted) return { events: [], ackAll: () => {} };
        if (
          this.writerClosed &&
          this.readSegmentId === this.tailSegment.id &&
          this.readOffset >= this.tailSegment.sizeOnDisk
        ) {
          return { events: [], ackAll: () => {} };
        }
        await waitFor(this.readerWaiters, options.signal);
      }
    };
    const result = this.readChain.then(run, run);
    this.readChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async readAvailable(maxEvents: number): Promise<{ events: Event[]; refs: RecordRef[] }> {
    const events: Event[] = [];
    const refs: RecordRef[] = [];

    while (events.length < maxEvents) {
      const seg = this.segments.find((s) => s.id === this.readSegmentId);
      if (seg === undefined) break;
      if (this.readOffset >= seg.sizeOnDisk) {
        const hasNext = this.segments.some((s) => s.id === this.readSegmentId + 1n);
        if (!hasNext) break;
        this.readSegmentId += 1n;
        this.readOffset = SEGMENT_HEADER_SIZE;
        continue;
      }

      const isTail = seg.id === this.tailSegment.id;
      const chunkLength = seg.sizeOnDisk - this.readOffset;
      const buffer = new Uint8Array(chunkLength);
      if (isTail) {
        await this.tailHandle.read(buffer, this.readOffset);
      } else {
        const handle = await this.fs.open(join(this.dir, segmentFileName(seg.id)), 'read');
        try {
          await handle.read(buffer, this.readOffset);
        } finally {
          await handle.close();
        }
      }

      let localOffset = 0;
      let stopSegment = false;
      while (localOffset < buffer.byteLength && events.length < maxEvents) {
        // The tail is always trusted: it was validated at open() and every byte since is our
        // own write. A sealed segment can legitimately still contain corruption recovery chose
        // to tolerate (see FORMAT.md §6), so it is re-scanned the same tolerant way here.
        if (isTail) {
          const record = readRecord(buffer, localOffset, this.maxRecordBytes);
          events.push(this.decodeAndTrack(record, seg.id, this.readOffset + localOffset, refs));
          localOffset += record.frameLength;
          continue;
        }

        const result = scanRecord(buffer, localOffset, this.maxRecordBytes);
        if (result.ok) {
          events.push(this.decodeAndTrack(result, seg.id, this.readOffset + localOffset, refs));
          localOffset += result.frameLength;
          continue;
        }

        this.metrics?.onCorruptRecord?.(
          result.reason === 'truncated' ? 'truncated-tail' : result.reason,
          seg.id,
        );
        if (this.corruption === 'stop') {
          throw new SegmentCorruptError(
            `corrupt record in sealed segment ${segmentFileName(seg.id)} at offset ${this.readOffset + localOffset}: ${result.reason}`,
          );
        }
        if (result.reason === 'bad-checksum') {
          localOffset += result.frameLength;
          continue;
        }
        // 'bad-length' (or an unexpected 'truncated' in a sealed segment): no safe resync point;
        // treat the rest of this segment as unreadable and move on to the next one.
        stopSegment = true;
        break;
      }
      this.readOffset += localOffset;
      if (stopSegment) this.readOffset = seg.sizeOnDisk;

      // Advance past a fully-consumed segment immediately, not on the next call's first check.
      // Otherwise the cursor can linger on this segment's id after `events.length === maxEvents`
      // ends the loop early, and an ack-driven delete (racing independently of this reader) can
      // remove that segment before the cursor ever moves off it — a permanent read deadlock.
      if (this.readOffset >= seg.sizeOnDisk) {
        const next = this.segments.find((s) => s.id === seg.id + 1n);
        if (next !== undefined) {
          this.readSegmentId = next.id;
          this.readOffset = SEGMENT_HEADER_SIZE;
        }
      }
    }
    return { events, refs };
  }

  private decodeAndTrack(
    record: { payload: Uint8Array; seq: bigint; frameLength: number },
    segmentId: bigint,
    offset: number,
    refs: RecordRef[],
  ): Event {
    const event = decodeEvent(record.payload);
    refs.push({
      segmentId,
      offset,
      frameEnd: offset + record.frameLength,
      seq: record.seq,
      size: record.frameLength,
    });
    return event;
  }

  private buildBatch(events: Event[], refs: RecordRef[]): ReadBatch {
    let bytes = 0;
    for (const ref of refs) {
      bytes += ref.size;
      this.outstanding.push(ref);
    }
    this.metrics?.onRead?.(events.length, bytes);

    for (let i = 0; i < events.length; i++) {
      const ref = refs[i]!;
      const notifier = new BatchNotifier();
      const finalizer = notifier.createFinalizer();
      events[i]!.metadata.finalizers.add(finalizer);
      notifier.seal();
      // `errored` means delivery failed transiently (retries exhausted, or the pipeline was
      // force-stopped): the record stays unacknowledged so it is redelivered after a restart
      // rather than silently lost. `delivered` and `rejected` (permanent failure) both release it.
      void notifier.completion.then((status) => {
        if (status !== 'errored') this.handleAck(ref);
      });
    }

    return {
      events,
      ackAll: (status: DeliveryStatus = 'delivered') => {
        for (const event of events) event.metadata.finalizers.finish(status);
      },
    };
  }

  // --- Acknowledgement -------------------------------------------------------------------------

  private handleAck(ref: RecordRef): void {
    this.metrics?.onAck?.(1, ref.size);
    this.ackedSeqSet.add(ref.seq);
    this.drainAckedPrefix();
  }

  private drainAckedPrefix(): void {
    let advanced = false;
    while (this.outstanding.length > 0 && this.ackedSeqSet.has(this.outstanding[0]!.seq)) {
      const front = this.outstanding.shift()!;
      this.ackedSeqSet.delete(front.seq);
      this.ackedSegmentId = front.segmentId;
      this.ackedOffset = front.frameEnd;
      this.ackedSeq = front.seq;
      this.bufferedEvents = Math.max(0, this.bufferedEvents - 1);
      advanced = true;

      // Roll the checkpoint forward across any segment that is now fully consumed.
      while (true) {
        const seg = this.segments.find((s) => s.id === this.ackedSegmentId);
        if (seg === undefined) break;
        const hasNext = this.segments.some((s) => s.id === this.ackedSegmentId + 1n);
        if (hasNext && this.ackedOffset >= seg.sizeOnDisk) {
          this.ackedSegmentId += 1n;
          this.ackedOffset = SEGMENT_HEADER_SIZE;
        } else {
          break;
        }
      }
    }
    if (advanced) {
      this.reportSize();
      this.scheduleLedgerWrite();
      if (this.outstanding.length === 0 && this.bufferedEvents === 0) {
        const waiters = this.drainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private scheduleLedgerWrite(): void {
    this.ledgerDirty = true;
    if (this.ledgerWriteInFlight !== undefined) return;
    this.ledgerWriteInFlight = this.runLedgerWriteLoop().finally(() => {
      this.ledgerWriteInFlight = undefined;
    });
  }

  private async runLedgerWriteLoop(): Promise<void> {
    while (this.ledgerDirty) {
      this.ledgerDirty = false;
      const segmentId = this.ackedSegmentId;
      const seq = this.ackedSeq;
      const offset =
        segmentId === this.tailSegment.id
          ? Math.min(this.ackedOffset, this.tailDurableLength)
          : this.ackedOffset;
      await writeLedger(this.fs, this.dir, {
        ackedSegmentId: segmentId,
        ackedOffset: offset,
        ackedSeq: seq,
      });
      await this.deleteObsoleteSegments(segmentId);
    }
  }

  private async deleteObsoleteSegments(uptoSegmentId: bigint): Promise<void> {
    let deleted = false;
    while (this.segments.length > 1 && this.segments[0]!.id < uptoSegmentId) {
      const seg = this.segments.shift()!;
      await this.fs.unlink(join(this.dir, segmentFileName(seg.id)));
      this.totalBytes -= seg.sizeOnDisk;
      this.metrics?.onSegmentDeleted?.(seg.id);
      deleted = true;
    }
    if (deleted) {
      this.reportSize();
      wakeAll(this.writerWaiters);
    }
  }

  // --- Lifecycle -----------------------------------------------------------------------------

  private async closeWriter(): Promise<void> {
    if (this.writerClosed) return;
    this.writerClosed = true;
    if (this.syncTimer !== undefined) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    await this.flushSyncWaiters();
    if (this.tailDurableLength < this.tailSegment.sizeOnDisk) {
      await this.doSync().catch(() => {});
    }
    wakeAll(this.readerWaiters);
  }

  private closeReader(): Promise<void> {
    if (!this.readerClosed) {
      this.readerClosed = true;
      wakeAll(this.readerWaiters);
    }
    return Promise.resolve();
  }

  private async closeAll(): Promise<void> {
    await this.closeWriter();
    await this.closeReader();
    await this.ledgerWriteInFlight;
    await this.tailHandle.close();
  }

  private async abort(): Promise<void> {
    this.aborted = true;
    wakeAll(this.writerWaiters);
    wakeAll(this.readerWaiters);
    await this.closeAll().catch(() => {});
  }

  private drain(): Promise<void> {
    if (this.bufferedEvents === 0 && this.outstanding.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }
}
