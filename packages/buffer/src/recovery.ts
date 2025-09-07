import { join } from 'node:path';
import { LedgerCorruptError, SegmentCorruptError } from './errors.js';
import type { FileSystem } from './filesystem.js';
import { readLedger, type LedgerState } from './ledger.js';
import {
  decodeSegmentHeader,
  encodeSegmentHeader,
  parseSegmentFileName,
  scanRecord,
  segmentFileName,
  SEGMENT_HEADER_SIZE,
} from './segment.js';
import type { BufferMetricsObserver, CorruptRecordKind } from './types.js';

/** A segment file on disk after recovery, with its validated (possibly truncated) size. */
export interface RecoveredSegment {
  id: bigint;
  sizeOnDisk: number;
}

export interface RecoveryOptions {
  fs: FileSystem;
  dir: string;
  maxRecordBytes: number;
  /** How to handle a corrupt record found in the middle of an already-sealed segment. */
  corruption: 'skip' | 'stop';
  metrics?: BufferMetricsObserver;
}

export interface RecoveryResult {
  /** Every segment on disk after recovery, ascending by id. Always at least one. */
  segments: RecoveredSegment[];
  /** The sequence number the writer should assign to the next record it appends. */
  nextSeq: bigint;
  ackedSegmentId: bigint;
  ackedOffset: number;
  ackedSeq: bigint;
  /** Where the reader should resume: equal to the acked position (redelivers unacked reads). */
  readSegmentId: bigint;
  readOffset: number;
  /** Total corrupt records found (and skipped or truncated away) across every segment. */
  corruptRecords: number;
}

function reasonToKind(reason: 'truncated' | 'bad-length' | 'bad-checksum'): CorruptRecordKind {
  return reason === 'truncated' ? 'truncated-tail' : reason;
}

/**
 * Opens (or initializes) a buffer directory: lists segments, validates and truncates the tail,
 * applies the `corruption` policy to any mid-file corruption in sealed segments, and computes
 * the recovered ledger position. See `FORMAT.md` for the full recovery algorithm.
 */
export async function recoverBuffer(options: RecoveryOptions): Promise<RecoveryResult> {
  const { fs, dir, maxRecordBytes, corruption, metrics } = options;
  await fs.mkdir(dir, true);

  const entries = await fs.readdir(dir);
  const ids = entries
    .map(parseSegmentFileName)
    .filter((id): id is bigint => id !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const segments: RecoveredSegment[] = [];
  let lastValidSeq: bigint | undefined;
  let corruptRecords = 0;

  if (ids.length === 0) {
    const id = 0n;
    const path = join(dir, segmentFileName(id));
    const handle = await fs.open(path, 'create-new');
    try {
      await handle.write(encodeSegmentHeader(), 0);
      await handle.fsync();
    } finally {
      await handle.close();
    }
    await fs.fsyncDir(dir);
    segments.push({ id, sizeOnDisk: SEGMENT_HEADER_SIZE });
  } else {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const isTail = i === ids.length - 1;
      const path = join(dir, segmentFileName(id));
      const handle = await fs.open(path, isTail ? 'read-write' : 'read');
      try {
        const stat = await handle.stat();
        const bytes = new Uint8Array(stat.size);
        await handle.read(bytes, 0);

        let headerValid = true;
        try {
          decodeSegmentHeader(bytes);
        } catch (error) {
          headerValid = false;
          corruptRecords++;
          metrics?.onCorruptRecord?.('bad-length', id);
          if (corruption === 'stop' && !isTail) throw error;
        }

        if (!headerValid) {
          if (isTail) {
            // Rewrite a fresh header; there is nothing else recoverable in this segment.
            await handle.truncate(0);
            await handle.write(encodeSegmentHeader(), 0);
            await handle.fsync();
            segments.push({ id, sizeOnDisk: SEGMENT_HEADER_SIZE });
          } else {
            segments.push({ id, sizeOnDisk: stat.size });
          }
          continue;
        }

        let offset = SEGMENT_HEADER_SIZE;
        for (;;) {
          if (offset === bytes.byteLength) {
            // Clean end of file: every record scanned successfully, nothing left to read.
            segments.push({ id, sizeOnDisk: isTail ? offset : stat.size });
            break;
          }

          const result = scanRecord(bytes, offset, maxRecordBytes);
          if (result.ok) {
            if (lastValidSeq === undefined || result.seq > lastValidSeq) lastValidSeq = result.seq;
            offset += result.frameLength;
            continue;
          }

          corruptRecords++;
          metrics?.onCorruptRecord?.(reasonToKind(result.reason), id);

          if (isTail) {
            // Whatever is left from here on is either an incomplete write or garbage; either
            // way it is not part of the durable log, so the tail is truncated to drop it.
            if (offset !== bytes.byteLength) {
              await handle.truncate(offset);
              await handle.fsync();
            }
            segments.push({ id, sizeOnDisk: offset });
            break;
          }

          // A sealed segment should never contain a partial write; finding one here means
          // corruption struck a segment we otherwise trust completely.
          if (corruption === 'stop') {
            throw new SegmentCorruptError(
              `corrupt record in sealed segment ${segmentFileName(id)} at offset ${offset}: ${result.reason}`,
            );
          }
          if (result.reason === 'bad-checksum') {
            // The frame's declared length is trustworthy; skip exactly past it and resync.
            offset += result.frameLength;
            continue;
          }
          // The length field itself may be corrupt: there is no safe way to resynchronize, so
          // reading stops here. The segment's on-disk bytes are left untouched.
          segments.push({ id, sizeOnDisk: stat.size });
          break;
        }
      } finally {
        await handle.close();
      }
    }
  }

  let ledgerState: LedgerState | undefined;
  try {
    ledgerState = await readLedger(fs, dir);
  } catch (error) {
    if (!(error instanceof LedgerCorruptError)) throw error;
    ledgerState = undefined;
  }

  let ackedSegmentId: bigint;
  let ackedOffset: number;
  let ackedSeq: bigint;
  const referenced =
    ledgerState === undefined
      ? undefined
      : segments.find((s) => s.id === ledgerState.ackedSegmentId);
  if (ledgerState !== undefined && referenced !== undefined) {
    ackedSegmentId = ledgerState.ackedSegmentId;
    ackedOffset = Math.min(ledgerState.ackedOffset, referenced.sizeOnDisk);
    ackedSeq = ledgerState.ackedSeq;
  } else {
    ackedSegmentId = segments[0]!.id;
    ackedOffset = SEGMENT_HEADER_SIZE;
    ackedSeq = 0n;
  }

  // Clean up segments that were fully acknowledged before a crash but never got deleted.
  const obsolete = segments.filter((s) => s.id < ackedSegmentId);
  if (obsolete.length > 0) {
    for (const s of obsolete) {
      await fs.unlink(join(dir, segmentFileName(s.id)));
    }
    await fs.fsyncDir(dir);
  }
  const remaining = segments.filter((s) => s.id >= ackedSegmentId);

  return {
    segments: remaining,
    nextSeq: lastValidSeq === undefined ? 0n : lastValidSeq + 1n,
    ackedSegmentId,
    ackedOffset,
    ackedSeq,
    readSegmentId: ackedSegmentId,
    readOffset: ackedOffset,
    corruptRecords,
  };
}
