import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import {
  decodeEvent,
  DiskBuffer,
  encodeEvent,
  encodeLedger,
  encodeRecord,
  InMemoryFileSystem,
  LEDGER_FILE_NAME,
  readLedger,
  RECORD_HEADER_SIZE,
  scanRecord,
  SegmentCorruptError,
  segmentFileName,
  SEGMENT_HEADER_SIZE,
  type BufferMetricsObserver,
  type CorruptRecordKind,
} from '@ferrule/buffer';

const DIR = '/buf';

function messagesOf(list: readonly unknown[]): string[] {
  return list.map((e) => (e as LogEvent).get('message') as string);
}

/** Writes `count` short events, closing the buffer afterward, and returns the raw fs. */
async function seedBuffer(count: number, maxSegmentBytes = 1_000_000): Promise<InMemoryFileSystem> {
  const fs = new InMemoryFileSystem();
  const buffer = await DiskBuffer.open(DIR, { fs, maxSegmentBytes, sync: { kind: 'always' } });
  for (let i = 0; i < count; i++) {
    await buffer.writer.write([LogEvent.fromMessage(`event ${i}`)]);
  }
  await buffer.close();
  return fs;
}

async function readAllBytes(fs: InMemoryFileSystem, path: string): Promise<Uint8Array> {
  const handle = await fs.open(path, 'read');
  try {
    const stat = await handle.stat();
    const buf = new Uint8Array(stat.size);
    await handle.read(buf, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

async function writeAllBytes(
  fs: InMemoryFileSystem,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await fs.open(path, 'read-write');
  try {
    await handle.truncate(bytes.byteLength);
    await handle.write(bytes, 0);
    await handle.fsync();
  } finally {
    await handle.close();
  }
}

describe('recovery: fresh and clean cases', () => {
  it('creates segment 0 when the directory is empty', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await DiskBuffer.open(DIR, { fs });
    expect(await fs.readdir(DIR)).toContain('00000000000000000000.seg');
    await buffer.close();
  });

  it('a clean reopen resumes reading unacknowledged events', async () => {
    const fs = await seedBuffer(3);
    const buffer = await DiskBuffer.open(DIR, { fs });
    const batch = await buffer.reader.read(3);
    expect(messagesOf(batch.events)).toEqual(['event 0', 'event 1', 'event 2']);
    await buffer.close();
  });

  it('a clean reopen does not redeliver acknowledged events', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await DiskBuffer.open(DIR, { fs });
    await buffer.writer.write([LogEvent.fromMessage('a')]);
    await buffer.writer.write([LogEvent.fromMessage('b')]);
    const batch = await buffer.reader.read(1);
    batch.ackAll();
    await buffer.close(); // waits for the ack's ledger write, without requiring a full drain

    const reopened = await DiskBuffer.open(DIR, { fs });
    const rest = await reopened.reader.read(10);
    expect(messagesOf(rest.events)).toEqual(['b']);
    await reopened.close();
  });
});

describe('recovery: torn tail record', () => {
  it('truncates a partially written trailing record and resumes writing after it', async () => {
    const fs = await seedBuffer(2);
    const path = join(DIR, segmentFileName(0n));
    const full = await readAllBytes(fs, path);

    // Simulate a crash mid-write of a third record: append a well-formed frame, then cut it off
    // partway through, as a torn write would leave it.
    const thirdPayload = encodeEvent(LogEvent.fromMessage('this record never finished writing'));
    const frame = encodeRecord(2n, thirdPayload);
    const torn = new Uint8Array(full.byteLength + Math.floor(frame.byteLength / 2));
    torn.set(full, 0);
    torn.set(frame.subarray(0, torn.byteLength - full.byteLength), full.byteLength);
    await writeAllBytes(fs, path, torn);

    const buffer = await DiskBuffer.open(DIR, { fs });
    // Recovery should have truncated the file back to `full`'s length.
    const validated = await readAllBytes(fs, path);
    expect(validated.byteLength).toBe(full.byteLength);

    // The buffer must remain writable: a new record appended after recovery is readable.
    await buffer.writer.write([LogEvent.fromMessage('after recovery')]);
    const batch = await buffer.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['event 0', 'event 1', 'after recovery']);
    await buffer.close();
  });

  it('reports the truncation via the corrupt-record metric', async () => {
    const fs = await seedBuffer(1);
    const path = join(DIR, segmentFileName(0n));
    const full = await readAllBytes(fs, path);
    const torn = full.slice(0, full.byteLength - 2); // cut into the last record
    await writeAllBytes(fs, path, torn);

    const kinds: CorruptRecordKind[] = [];
    const metrics: BufferMetricsObserver = { onCorruptRecord: (kind) => kinds.push(kind) };
    const buffer = await DiskBuffer.open(DIR, { fs, metrics });
    expect(kinds).toContain('truncated-tail');
    await buffer.close();
  });

  it('truncates the tail even with default corruption: "skip" and no records survive', async () => {
    const fs = new InMemoryFileSystem();
    const buffer0 = await DiskBuffer.open(DIR, { fs });
    await buffer0.close();
    const path = join(DIR, segmentFileName(0n));
    const header = await readAllBytes(fs, path);
    // Header only, plus a few garbage bytes that don't form a full record frame.
    const garbage = new Uint8Array(header.byteLength + 3);
    garbage.set(header, 0);
    garbage.set([1, 2, 3], header.byteLength);
    await writeAllBytes(fs, path, garbage);

    const buffer = await DiskBuffer.open(DIR, { fs });
    const validated = await readAllBytes(fs, path);
    expect(validated.byteLength).toBe(SEGMENT_HEADER_SIZE);
    await buffer.close();
  });
});

describe('recovery: corruption in the middle of a sealed segment', () => {
  async function seedTwoSealedSegments(): Promise<InMemoryFileSystem> {
    // Force every event into its own segment so segment 0 is fully sealed once segment 1 exists.
    const fs = new InMemoryFileSystem();
    const buffer = await DiskBuffer.open(DIR, { fs, maxSegmentBytes: 40 });
    await buffer.writer.write([LogEvent.fromMessage('seg0-a')]);
    await buffer.writer.write([LogEvent.fromMessage('seg1-a')]); // rolls into segment 1
    await buffer.writer.write([LogEvent.fromMessage('seg2-a')]); // rolls into segment 2 (tail)
    await buffer.close();
    return fs;
  }

  it('"skip" (default) skips a bad-checksum record and keeps reading records after it', async () => {
    const fs = await seedTwoSealedSegments();
    const path = join(DIR, segmentFileName(0n));
    const bytes = await readAllBytes(fs, path);
    const corrupted = bytes.slice();
    corrupted[SEGMENT_HEADER_SIZE + RECORD_HEADER_SIZE]! ^= 0xff; // corrupt the payload
    await writeAllBytes(fs, path, corrupted);

    const kinds: CorruptRecordKind[] = [];
    const metrics: BufferMetricsObserver = { onCorruptRecord: (kind) => kinds.push(kind) };
    const buffer = await DiskBuffer.open(DIR, { fs, corruption: 'skip', metrics });
    expect(kinds).toContain('bad-checksum');
    // Segment 0's only record was corrupted (skipped); segments 1 and 2 are unaffected.
    const batch = await buffer.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['seg1-a', 'seg2-a']);
    await buffer.close();
  });

  it('"stop" throws SegmentCorruptError instead of silently skipping', async () => {
    const fs = await seedTwoSealedSegments();
    const path = join(DIR, segmentFileName(0n));
    const bytes = await readAllBytes(fs, path);
    const corrupted = bytes.slice();
    corrupted[SEGMENT_HEADER_SIZE + RECORD_HEADER_SIZE]! ^= 0xff;
    await writeAllBytes(fs, path, corrupted);

    await expect(DiskBuffer.open(DIR, { fs, corruption: 'stop' })).rejects.toBeInstanceOf(
      SegmentCorruptError,
    );
  });

  it('a "bad-length" corruption in a sealed segment stops reading that segment but not later ones', async () => {
    const fs = await seedTwoSealedSegments();
    const path = join(DIR, segmentFileName(0n));
    const bytes = await readAllBytes(fs, path);
    const corrupted = bytes.slice();
    // Corrupt the 4-byte length field itself to an implausibly large value.
    corrupted[SEGMENT_HEADER_SIZE] = 0xff;
    corrupted[SEGMENT_HEADER_SIZE + 1] = 0xff;
    corrupted[SEGMENT_HEADER_SIZE + 2] = 0xff;
    corrupted[SEGMENT_HEADER_SIZE + 3] = 0x7f;
    await writeAllBytes(fs, path, corrupted);

    const kinds: CorruptRecordKind[] = [];
    const metrics: BufferMetricsObserver = { onCorruptRecord: (kind) => kinds.push(kind) };
    const buffer = await DiskBuffer.open(DIR, { fs, corruption: 'skip', metrics });
    expect(kinds).toContain('bad-length');
    const batch = await buffer.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['seg1-a', 'seg2-a']);
    await buffer.close();
  });

  it('scanRecord/segment invariants: a corrupted sealed segment file is left untouched on disk', async () => {
    const fs = await seedTwoSealedSegments();
    const path = join(DIR, segmentFileName(0n));
    const bytes = await readAllBytes(fs, path);
    const corrupted = bytes.slice();
    corrupted[SEGMENT_HEADER_SIZE + RECORD_HEADER_SIZE]! ^= 0xff;
    await writeAllBytes(fs, path, corrupted);
    const before = await readAllBytes(fs, path);

    const buffer = await DiskBuffer.open(DIR, { fs, corruption: 'skip' });
    const after = await readAllBytes(fs, path);
    expect(after).toEqual(before);
    await buffer.close();
  });
});

describe('recovery: ledger fallback', () => {
  it('falls back to the oldest segment when there is no ledger yet', async () => {
    const fs = await seedBuffer(2);
    expect(await fs.exists(join(DIR, LEDGER_FILE_NAME))).toBe(false);
    const buffer = await DiskBuffer.open(DIR, { fs });
    const batch = await buffer.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['event 0', 'event 1']);
    await buffer.close();
  });

  it('falls back to the oldest segment when the ledger file is corrupt', async () => {
    const fs = new InMemoryFileSystem();
    const buffer0 = await DiskBuffer.open(DIR, { fs });
    await buffer0.writer.write([LogEvent.fromMessage('a')]);
    const batch0 = await buffer0.reader.read(1);
    batch0.ackAll();
    await buffer0.drain();
    await buffer0.close();
    expect(await fs.exists(join(DIR, LEDGER_FILE_NAME))).toBe(true);

    // Corrupt the ledger in place.
    const path = join(DIR, LEDGER_FILE_NAME);
    const bytes = await readAllBytes(fs, path);
    bytes[0] = 0;
    await writeAllBytes(fs, path, bytes);

    // Recovery should not throw; it falls back to the oldest segment on disk (redelivering "a").
    const buffer = await DiskBuffer.open(DIR, { fs });
    const rest = await buffer.reader.read(10);
    expect(messagesOf(rest.events)).toEqual(['a']);
    await buffer.close();
  });

  it('clamps a ledger offset that would exceed the (now validated) segment size', async () => {
    const fs = new InMemoryFileSystem();
    const buffer0 = await DiskBuffer.open(DIR, { fs });
    await buffer0.writer.write([LogEvent.fromMessage('a')]);
    await buffer0.close();

    const path = join(DIR, LEDGER_FILE_NAME);
    const bogus = encodeLedger({ ackedSegmentId: 0n, ackedOffset: 999_999, ackedSeq: 0n });
    const handle = await fs.open(path, 'create');
    await handle.write(bogus, 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir(DIR);

    // Must not throw despite the out-of-range offset.
    const buffer = await DiskBuffer.open(DIR, { fs });
    await buffer.close();
  });

  it('deletes segments that were fully acknowledged before a crash but never got cleaned up', async () => {
    // Build two segments, then write a ledger claiming segment 0 is fully acknowledged, without
    // ever going through the buffer's own (ledger-write-then-delete) cleanup path. This is
    // exactly the state a crash between "ledger durably written" and "segment unlinked" leaves.
    const fs = new InMemoryFileSystem();
    const buffer = await DiskBuffer.open(DIR, { fs, maxSegmentBytes: 40 });
    await buffer.writer.write([LogEvent.fromMessage('seg0')]);
    await buffer.writer.write([LogEvent.fromMessage('seg1')]); // rolls to segment 1
    await buffer.writer.close();
    await buffer.reader.close();
    await buffer.close();

    const seg0 = join(DIR, segmentFileName(0n));
    expect(await fs.exists(seg0)).toBe(true);
    const ledgerBytes = encodeLedger({
      ackedSegmentId: 1n,
      ackedOffset: SEGMENT_HEADER_SIZE,
      ackedSeq: 0n,
    });
    const ledgerPath = join(DIR, LEDGER_FILE_NAME);
    const handle = await fs.open(ledgerPath, 'create');
    await handle.truncate(0);
    await handle.write(ledgerBytes, 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir(DIR);

    const reopened = await DiskBuffer.open(DIR, { fs });
    expect(await fs.exists(seg0)).toBe(false); // recovery's cleanup pass removed it
    const batch = await reopened.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['seg1']); // segment 1 was never acknowledged
    await reopened.close();
  });
});

describe('recovery: ledger position sanity', () => {
  it('the recovered ledger never regresses relative to what was durably acknowledged', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await DiskBuffer.open(DIR, { fs });
    await buffer.writer.write([LogEvent.fromMessage('a')]);
    const batch = await buffer.reader.read(1);
    batch.ackAll();
    await buffer.drain();
    await buffer.close();

    const ledger = await readLedger(fs, DIR);
    expect(ledger).toBeDefined();
    expect(ledger!.ackedOffset).toBeGreaterThan(SEGMENT_HEADER_SIZE - 1);
  });
});

describe('sanity: scanRecord agrees with what recovery actually does', () => {
  it('a segment with only a clean header and no records recovers as empty', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await DiskBuffer.open(DIR, { fs });
    await buffer.close();
    const bytes = await readAllBytes(fs, join(DIR, segmentFileName(0n)));
    expect(scanRecord(bytes, SEGMENT_HEADER_SIZE, 1024).ok).toBe(false);
  });

  it('decodeEvent still works on a payload recovered via scanRecord', async () => {
    const fs = await seedBuffer(1);
    const bytes = await readAllBytes(fs, join(DIR, segmentFileName(0n)));
    const result = scanRecord(bytes, SEGMENT_HEADER_SIZE, 1024);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const event = decodeEvent(result.payload) as LogEvent;
      expect(event.get('message')).toBe('event 0');
    }
  });
});
