import { join } from 'node:path';
import { ByteReader, ByteWriter } from './byte-io.js';
import { crc32c } from './crc32c.js';
import { CodecVersionError, LedgerCorruptError } from './errors.js';
import type { FileSystem } from './filesystem.js';

/**
 * The ledger (checkpoint) file: a small, fixed-size record of the durable read position — the
 * point up to which every record, across every segment, is known to have been acknowledged. See
 * `FORMAT.md` for the byte layout and the atomic write protocol.
 */

// Note: Uint8Array instances with elements cannot be frozen with Object.freeze (V8 throws), so
// this relies on convention (nothing in this module mutates it) rather than true immutability.
export const LEDGER_MAGIC: Readonly<Uint8Array> = new Uint8Array([0x46, 0x52, 0x4c, 0x47]); // "FRLG"
export const LEDGER_FORMAT_VERSION = 1;
export const LEDGER_FILE_NAME = 'ledger';
export const LEDGER_TMP_FILE_NAME = 'ledger.tmp';
/** magic(4) + version(1) + reserved(3) + ackedSegmentId(8) + ackedOffset(4) + ackedSeq(8) + crc32c(4) */
export const LEDGER_SIZE = 4 + 1 + 3 + 8 + 4 + 8 + 4;

/** The durable read checkpoint: every record before this position has been fully acknowledged. */
export interface LedgerState {
  /** Id of the segment containing the first not-yet-fully-acknowledged record. */
  ackedSegmentId: bigint;
  /** Byte offset of that record within its segment. */
  ackedOffset: number;
  /** Sequence number of that record, kept for a consistency check against the segment contents. */
  ackedSeq: bigint;
}

export function encodeLedger(state: LedgerState): Uint8Array {
  const w = new ByteWriter(LEDGER_SIZE);
  w.writeRawBytes(LEDGER_MAGIC);
  w.writeUint8(LEDGER_FORMAT_VERSION);
  w.writeUint8(0);
  w.writeUint8(0);
  w.writeUint8(0);
  w.writeUint64LE(state.ackedSegmentId);
  w.writeUint32LE(state.ackedOffset);
  w.writeUint64LE(state.ackedSeq);
  const body = w.toUint8Array();
  w.writeUint32LE(crc32c(body));
  return w.toUint8Array();
}

export function decodeLedger(bytes: Uint8Array): LedgerState {
  if (bytes.byteLength !== LEDGER_SIZE) {
    throw new LedgerCorruptError(
      `ledger file has the wrong size: expected ${LEDGER_SIZE} bytes, found ${bytes.byteLength}`,
    );
  }
  for (let i = 0; i < LEDGER_MAGIC.length; i++) {
    if (bytes[i] !== LEDGER_MAGIC[i]) {
      throw new LedgerCorruptError('ledger has an invalid magic number');
    }
  }
  const version = bytes[4]!;
  if (version !== LEDGER_FORMAT_VERSION) throw new CodecVersionError(version);

  const body = bytes.subarray(0, LEDGER_SIZE - 4);
  const storedCrc = new ByteReader(bytes.subarray(LEDGER_SIZE - 4)).readUint32LE();
  if (crc32c(body) !== storedCrc) throw new LedgerCorruptError('ledger checksum mismatch');

  const r = new ByteReader(bytes.subarray(SegmentFieldsOffset));
  const ackedSegmentId = r.readUint64LE();
  const ackedOffset = r.readUint32LE();
  const ackedSeq = r.readUint64LE();
  return { ackedSegmentId, ackedOffset, ackedSeq };
}

const SegmentFieldsOffset = 8; // magic(4) + version(1) + reserved(3)

/**
 * Writes the ledger atomically: write the temp file, fsync it, rename it over the real ledger,
 * then fsync the directory so the rename itself survives a crash (see `FORMAT.md`).
 */
export async function writeLedger(fs: FileSystem, dir: string, state: LedgerState): Promise<void> {
  const tmpPath = join(dir, LEDGER_TMP_FILE_NAME);
  const finalPath = join(dir, LEDGER_FILE_NAME);
  const bytes = encodeLedger(state);

  const handle = await fs.open(tmpPath, 'create');
  try {
    await handle.truncate(0);
    await handle.write(bytes, 0);
    await handle.fsync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, finalPath);
  await fs.fsyncDir(dir);
}

/**
 * Reads the ledger, or `undefined` if it does not exist yet (a brand-new buffer, or a crash
 * before the first ledger write ever completed). Throws {@link LedgerCorruptError} if the file
 * exists but is not well-formed; the caller decides how to fall back (see `disk-buffer.ts`).
 */
export async function readLedger(fs: FileSystem, dir: string): Promise<LedgerState | undefined> {
  const finalPath = join(dir, LEDGER_FILE_NAME);
  if (!(await fs.exists(finalPath))) return undefined;
  const handle = await fs.open(finalPath, 'read');
  try {
    const stat = await handle.stat();
    const buffer = new Uint8Array(stat.size);
    await handle.read(buffer, 0);
    return decodeLedger(buffer);
  } finally {
    await handle.close();
  }
}
