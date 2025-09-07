import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CodecVersionError,
  decodeLedger,
  encodeLedger,
  InMemoryFileSystem,
  LedgerCorruptError,
  LEDGER_FILE_NAME,
  LEDGER_SIZE,
  LEDGER_TMP_FILE_NAME,
  readLedger,
  writeLedger,
  type LedgerState,
} from '@ferrule/buffer';

const arbLedgerState: fc.Arbitrary<LedgerState> = fc.record({
  ackedSegmentId: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
  ackedOffset: fc.integer({ min: 0, max: 0xffffffff }),
  ackedSeq: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
});

describe('encodeLedger / decodeLedger', () => {
  it('round-trips (property)', () => {
    fc.assert(
      fc.property(arbLedgerState, (state) => {
        const decoded = decodeLedger(encodeLedger(state));
        expect(decoded).toEqual(state);
      }),
    );
  });

  it('produces a fixed-size buffer', () => {
    const bytes = encodeLedger({ ackedSegmentId: 1n, ackedOffset: 2, ackedSeq: 3n });
    expect(bytes.byteLength).toBe(LEDGER_SIZE);
  });

  it('rejects the wrong size', () => {
    const bytes = encodeLedger({ ackedSegmentId: 0n, ackedOffset: 0, ackedSeq: 0n });
    expect(() => decodeLedger(bytes.slice(0, bytes.byteLength - 1))).toThrow(LedgerCorruptError);
  });

  it('rejects a bad magic number', () => {
    const bytes = encodeLedger({ ackedSegmentId: 0n, ackedOffset: 0, ackedSeq: 0n });
    bytes[0] = 0;
    expect(() => decodeLedger(bytes)).toThrow(LedgerCorruptError);
  });

  it('rejects an unsupported version', () => {
    const bytes = encodeLedger({ ackedSegmentId: 0n, ackedOffset: 0, ackedSeq: 0n });
    bytes[4] = 7;
    expect(() => decodeLedger(bytes)).toThrow(CodecVersionError);
  });

  it('rejects a corrupted checksum', () => {
    const bytes = encodeLedger({ ackedSegmentId: 1n, ackedOffset: 1, ackedSeq: 1n });
    bytes[8]! ^= 0xff; // corrupt a data byte without touching the trailing crc
    expect(() => decodeLedger(bytes)).toThrow(LedgerCorruptError);
  });

  it('never throws anything but LedgerCorruptError/CodecVersionError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          decodeLedger(bytes);
        } catch (error) {
          expect(error instanceof LedgerCorruptError || error instanceof CodecVersionError).toBe(
            true,
          );
        }
      }),
    );
  });
});

describe('writeLedger / readLedger', () => {
  it('returns undefined when no ledger has ever been written', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/buf', true);
    expect(await readLedger(fs, '/buf')).toBeUndefined();
  });

  it('writes and reads back the same state', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/buf', true);
    const state: LedgerState = { ackedSegmentId: 5n, ackedOffset: 128, ackedSeq: 99n };
    await writeLedger(fs, '/buf', state);
    expect(await readLedger(fs, '/buf')).toEqual(state);
  });

  it('later writes overwrite earlier ones', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/buf', true);
    await writeLedger(fs, '/buf', { ackedSegmentId: 1n, ackedOffset: 1, ackedSeq: 1n });
    await writeLedger(fs, '/buf', { ackedSegmentId: 2n, ackedOffset: 2, ackedSeq: 2n });
    expect(await readLedger(fs, '/buf')).toEqual({
      ackedSegmentId: 2n,
      ackedOffset: 2,
      ackedSeq: 2n,
    });
  });

  it('does not leave a stray tmp file behind after a successful write', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/buf', true);
    await writeLedger(fs, '/buf', { ackedSegmentId: 1n, ackedOffset: 1, ackedSeq: 1n });
    const names = await fs.readdir('/buf');
    expect(names).toContain(LEDGER_FILE_NAME);
    expect(names).not.toContain(LEDGER_TMP_FILE_NAME);
  });

  it('a crash before the rename leaves the previous ledger (or none) intact', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/buf', true);
    await writeLedger(fs, '/buf', { ackedSegmentId: 1n, ackedOffset: 1, ackedSeq: 1n });

    // Start a second write but crash before its rename+dir-fsync land.
    fs.injectFault({ op: 'rename', path: '/buf/ledger.tmp', error: new Error('simulated crash') });
    await expect(
      writeLedger(fs, '/buf', { ackedSegmentId: 2n, ackedOffset: 2, ackedSeq: 2n }),
    ).rejects.toThrow();
    fs.clearFaults();
    fs.crash();

    expect(await readLedger(fs, '/buf')).toEqual({
      ackedSegmentId: 1n,
      ackedOffset: 1,
      ackedSeq: 1n,
    });
  });

  it('a crash after fsync but before the directory fsync can revert the rename', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/buf', true);
    await writeLedger(fs, '/buf', { ackedSegmentId: 1n, ackedOffset: 1, ackedSeq: 1n });

    fs.injectFault({ op: 'fsyncDir', path: '/buf', error: new Error('simulated crash') });
    await expect(
      writeLedger(fs, '/buf', { ackedSegmentId: 2n, ackedOffset: 2, ackedSeq: 2n }),
    ).rejects.toThrow();
    fs.clearFaults();
    fs.crash();

    // The rename was never made durable, so the previous ledger is what survives.
    expect(await readLedger(fs, '/buf')).toEqual({
      ackedSegmentId: 1n,
      ackedOffset: 1,
      ackedSeq: 1n,
    });
  });
});
