import { ByteWriter } from './byte-io.js';
import { crc32c } from './crc32c.js';
import { CodecVersionError, SegmentCorruptError } from './errors.js';

/**
 * Segment file framing. A segment is a sequence of length-prefixed, checksummed records behind
 * an 8-byte header. See `FORMAT.md` for the full byte layout and the recovery policy for each
 * kind of corruption {@link scanRecord} can report.
 */

// Note: Uint8Array instances with elements cannot be frozen with Object.freeze (V8 throws), so
// this relies on convention (nothing in this module mutates it) rather than true immutability.
export const SEGMENT_MAGIC: Readonly<Uint8Array> = new Uint8Array([0x46, 0x52, 0x42, 0x31]); // "FRB1"
export const SEGMENT_FORMAT_VERSION = 1;
export const SEGMENT_HEADER_SIZE = 8;
export const RECORD_HEADER_SIZE = 16;

/** Number of decimal digits in a segment filename, e.g. `00000000000000000003.seg`. */
export const SEGMENT_ID_DIGITS = 20;

const SEGMENT_FILE_PATTERN = /^(\d{20})\.seg$/;

/** The filename for segment `id`, matching the layout described in `FORMAT.md`. */
export function segmentFileName(id: bigint): string {
  if (id < 0n) throw new RangeError(`segment id must not be negative, got ${id}`);
  return `${id.toString().padStart(SEGMENT_ID_DIGITS, '0')}.seg`;
}

/** Parses a segment filename back into its id, or `undefined` if `name` is not a segment file. */
export function parseSegmentFileName(name: string): bigint | undefined {
  const match = SEGMENT_FILE_PATTERN.exec(name);
  return match === null ? undefined : BigInt(match[1]!);
}

/** The fixed 8-byte header written at the start of every segment file. */
export function encodeSegmentHeader(): Uint8Array {
  const w = new ByteWriter(SEGMENT_HEADER_SIZE);
  w.writeRawBytes(SEGMENT_MAGIC);
  w.writeUint8(SEGMENT_FORMAT_VERSION);
  w.writeUint8(0);
  w.writeUint8(0);
  w.writeUint8(0);
  return w.toUint8Array();
}

/** Validates a segment header. Throws {@link SegmentCorruptError} or {@link CodecVersionError}. */
export function decodeSegmentHeader(bytes: Uint8Array): void {
  if (bytes.byteLength < SEGMENT_HEADER_SIZE) {
    throw new SegmentCorruptError(
      `segment header is truncated: expected ${SEGMENT_HEADER_SIZE} bytes, found ${bytes.byteLength}`,
    );
  }
  for (let i = 0; i < SEGMENT_MAGIC.length; i++) {
    if (bytes[i] !== SEGMENT_MAGIC[i]) {
      throw new SegmentCorruptError('segment header has an invalid magic number');
    }
  }
  const version = bytes[4]!;
  if (version !== SEGMENT_FORMAT_VERSION) throw new CodecVersionError(version);
}

/**
 * Encodes one record: a monotonic sequence number and an opaque payload (the codec-encoded
 * event). The frame is `length(4) ++ seq(8) ++ crc32c(4) ++ payload`, where the checksum covers
 * `length ++ seq ++ payload`.
 */
export function encodeRecord(seq: bigint, payload: Uint8Array): Uint8Array {
  const w = new ByteWriter(RECORD_HEADER_SIZE + payload.byteLength);
  w.writeUint32LE(payload.byteLength);
  w.writeUint64LE(seq);
  const lengthAndSeq = w.toUint8Array();
  const checksum = crc32c(payload, crc32c(lengthAndSeq));
  w.writeUint32LE(checksum);
  w.writeRawBytes(payload);
  return w.toUint8Array();
}

/** Successful or unsuccessful outcome of scanning one record at a given offset. See `FORMAT.md`. */
export type RecordScanResult =
  | { ok: true; seq: bigint; payload: Uint8Array; frameLength: number }
  | {
      ok: false;
      /**
       * `truncated`: fewer bytes are present than the frame needs (a torn write; safe to resync
       * from a later, complete write, but not within this frame). `bad-length`: the declared
       * payload length is implausible, most likely because the length field itself is corrupt —
       * the true frame size is unknown, so recovery cannot safely resynchronize past this point.
       * `bad-checksum`: the frame is complete and self-consistent in size, but its checksum does
       * not match — recovery can safely skip exactly `frameLength` bytes and resume after it.
       */
      reason: 'truncated' | 'bad-length' | 'bad-checksum';
      frameLength: number;
    };

/**
 * Reads one record from `data` at `offset` without throwing: corruption is reported in the
 * result so a caller (typically recovery) can apply its own policy. `maxPayloadBytes` bounds the
 * accepted payload length, guarding against treating a corrupt length field as a huge allocation.
 */
export function scanRecord(
  data: Uint8Array,
  offset: number,
  maxPayloadBytes: number,
): RecordScanResult {
  const available = data.byteLength - offset;
  if (available < RECORD_HEADER_SIZE) {
    return { ok: false, reason: 'truncated', frameLength: Math.max(available, 0) };
  }
  const length =
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24);
  const unsignedLength = length >>> 0;
  if (unsignedLength > maxPayloadBytes) {
    return { ok: false, reason: 'bad-length', frameLength: RECORD_HEADER_SIZE };
  }
  const frameLength = RECORD_HEADER_SIZE + unsignedLength;
  if (available < frameLength) {
    return { ok: false, reason: 'truncated', frameLength: available };
  }

  let seq = 0n;
  for (let i = 7; i >= 0; i--) {
    seq = (seq << 8n) | BigInt(data[offset + 4 + i]!);
  }
  const storedCrc =
    data[offset + 12]! |
    (data[offset + 13]! << 8) |
    (data[offset + 14]! << 16) |
    (data[offset + 15]! << 24);

  const lengthAndSeq = data.subarray(offset, offset + 12);
  const payload = data.subarray(offset + RECORD_HEADER_SIZE, offset + frameLength);
  const expectedCrc = crc32c(payload, crc32c(lengthAndSeq));
  if (expectedCrc >>> 0 !== storedCrc >>> 0) {
    return { ok: false, reason: 'bad-checksum', frameLength };
  }
  return { ok: true, seq, payload: payload.slice(), frameLength };
}

/**
 * Reads one record like {@link scanRecord}, but throws {@link SegmentCorruptError} instead of
 * returning a failure result. Used on the normal read path, where the segment has already been
 * through recovery and a bad record indicates an unexpected condition worth surfacing loudly.
 */
export function readRecord(
  data: Uint8Array,
  offset: number,
  maxPayloadBytes: number,
): { seq: bigint; payload: Uint8Array; frameLength: number } {
  const result = scanRecord(data, offset, maxPayloadBytes);
  if (result.ok) return result;
  throw new SegmentCorruptError(`corrupt record at offset ${offset}: ${result.reason}`);
}
