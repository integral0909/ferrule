import { FerruleError, LimitExceededError } from '@ferrule/core';
import { xxhash32 } from './xxhash32.js';

/**
 * A hand-written implementation of the LZ4 **block format** and **frame format**
 * (<https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md> and
 * `lz4_Frame_format.md` in the same directory), used by the Kafka producer/consumer
 * (`kafka/record-batch.ts`, RecordBatch attribute codec `3`) and needed because there is no
 * third-party dependency available here (see `CONTRIBUTING.md`'s dependency policy) and
 * `node:zlib` has no LZ4 support (unlike gzip/deflate/brotli/zstd, all of which it does provide).
 *
 * **Block format.** A sequence of "sequences", each a token byte (literal-length nibble, then
 * match-length nibble), an optional extended literal length, the literal bytes themselves, and
 * (except for the block's final sequence, which is literals only) a 2-byte little-endian match
 * offset and an optional extended match length. The compressor here is a straightforward
 * single-hash greedy LZ77 matcher (a `Int32Array` hash table over 4-byte windows, like
 * `../../../sinks/src/http/snappy.ts`'s Snappy compressor): it is not the most aggressive
 * possible LZ4 encoder, but every sequence it emits follows the format exactly — matches never
 * start within the mandatory final 5 literal bytes of a block, offsets are always `<= 65535` (a
 * 64KiB window) — so any spec-compliant LZ4 decoder can read its output (confirmed in
 * `test/compression/lz4.test.ts` against the real `lz4` CLI). Every block this encoder writes is
 * **independent** (its match window never reaches into a previous block), matching the frame
 * header's declared block-independence flag; the decoder itself does not need to treat
 * independent/dependent blocks differently, since it always decodes into one contiguous output
 * buffer that a match offset can address regardless of which block wrote the bytes it points at.
 *
 * **Frame format.** Magic number, an `FLG`/`BD` descriptor byte pair, a header checksum, one or
 * more length-prefixed blocks (the high bit of the 4-byte length marks an uncompressed/"raw"
 * block), a zero-length end mark, and an optional whole-content checksum — `FLG`'s content/block
 * checksum bits both select **XXH32** (`xxhash32.ts`), seeded with `0`, exactly as the frame spec
 * requires. The encoder here always turns the content checksum on and the block checksum off (an
 * `lz4` CLI vector with a block checksum is still decoded correctly — see the fixtures — this
 * encoder just does not write one); it never reads or writes a dictionary ID (an external
 * dictionary is not supported, and a frame requesting one is rejected with a typed error).
 *
 * Decompression is bounded throughout — both a per-block cap (the frame's own declared block
 * maximum size) and a caller-supplied overall cap — and never throws anything but a
 * `FerruleError` subclass, however malformed the input, the same contract `snappyDecompress`
 * gives its callers.
 */

const MAGIC = 0x184d2204;
const MINMATCH = 4;
const LASTLITERALS = 5;
const HASH_LOG = 16;
const HASH_SIZE = 1 << HASH_LOG;
const MAX_OFFSET = 0xffff;

// BD byte's 3-bit "block max size" field only uses indices 4-7; 0-3 are reserved/unused.
const BLOCK_MAX_SIZE_BY_INDEX: readonly number[] = [
  0,
  0,
  0,
  0,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
];
const DEFAULT_BLOCK_MAX_SIZE_INDEX = 7; // 4MiB — most Kafka/HTTP payloads fit in a single block.
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

function fail(message: string, cause?: unknown): never {
  throw new FerruleError('E_LZ4_CORRUPT', `corrupt LZ4 stream: ${message}`, { cause });
}

// --- block format: compression -----------------------------------------------------------

function hash4(input: Uint8Array, pos: number): number {
  const v =
    (input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16) | (input[pos + 3]! << 24)) >>>
    0;
  return (Math.imul(v, 2654435761) >>> (32 - HASH_LOG)) & (HASH_SIZE - 1);
}

function writeExtraLength(out: number[], extra: number): void {
  // `extra` is already `declaredLength - 15` and known to be `>= 0`.
  let n = extra;
  while (n >= 255) {
    out.push(255);
    n -= 255;
  }
  out.push(n);
}

/**
 * Compresses `input` as one LZ4 **block** (no frame envelope). `input.length` must not exceed a
 * block's declared maximum size when this is embedded in a frame — `lz4Compress` enforces that by
 * chunking; calling this directly with an oversized input still produces a correct block, just
 * one `lz4DecompressBlock` would need a larger-than-default output bound to read back.
 */
export function lz4CompressBlock(input: Uint8Array): Uint8Array {
  const inputEnd = input.length;
  const out: number[] = [];
  const hashTable = new Int32Array(HASH_SIZE).fill(-1);
  let anchor = 0;
  let i = 0;

  function emitSequence(
    litStart: number,
    litEnd: number,
    matchOffset: number,
    matchLen: number,
  ): void {
    const litLen = litEnd - litStart;
    const litNibble = litLen < 15 ? litLen : 15;
    const matchNibble = matchOffset === 0 ? 0 : matchLen - MINMATCH < 15 ? matchLen - MINMATCH : 15;
    out.push(((litNibble << 4) | matchNibble) & 0xff);
    if (litNibble === 15) writeExtraLength(out, litLen - 15);
    for (let p = litStart; p < litEnd; p++) out.push(input[p]!);
    if (matchOffset !== 0) {
      out.push(matchOffset & 0xff, (matchOffset >>> 8) & 0xff);
      if (matchNibble === 15) writeExtraLength(out, matchLen - MINMATCH - 15);
    }
  }

  // Matches may never start so late that they'd need to consume the mandatory final
  // `LASTLITERALS` literal bytes, and a match is at least `MINMATCH` bytes.
  const searchLimit = inputEnd - LASTLITERALS - MINMATCH;
  if (searchLimit >= 0) {
    while (i <= searchLimit) {
      const h = hash4(input, i);
      const ref = hashTable[h]!;
      hashTable[h] = i;
      if (
        ref >= 0 &&
        i - ref <= MAX_OFFSET &&
        input[ref] === input[i] &&
        input[ref + 1] === input[i + 1] &&
        input[ref + 2] === input[i + 2] &&
        input[ref + 3] === input[i + 3]
      ) {
        let matchLen = MINMATCH;
        const maxMatch = inputEnd - LASTLITERALS;
        while (i + matchLen < maxMatch && input[ref + matchLen] === input[i + matchLen]) {
          matchLen++;
        }
        emitSequence(anchor, i, i - ref, matchLen);
        i += matchLen;
        anchor = i;
      } else {
        i++;
      }
    }
  }
  emitSequence(anchor, inputEnd, 0, 0);
  return Uint8Array.from(out);
}

// --- block format: decompression ---------------------------------------------------------

/**
 * Decompresses one LZ4 **block** (no frame envelope) into at most `maxOutputSize` bytes. Every
 * input access is bounds-checked; malformed input raises `FerruleError` (`E_LZ4_CORRUPT`), never
 * an uncaught `RangeError`.
 */
export function lz4DecompressBlock(input: Uint8Array, maxOutputSize: number): Uint8Array {
  const out = new Uint8Array(maxOutputSize);
  let ip = 0;
  let op = 0;
  const inLen = input.length;

  function readExtraLength(): number {
    let extra = 0;
    for (;;) {
      if (ip >= inLen) fail('truncated length sequence');
      const b = input[ip]!;
      ip++;
      extra += b;
      if (b !== 255) return extra;
    }
  }

  while (ip < inLen) {
    const token = input[ip]!;
    ip++;
    let litLen = token >>> 4;
    if (litLen === 15) litLen += readExtraLength();
    if (ip + litLen > inLen) fail('truncated literal run');
    if (op + litLen > maxOutputSize) throw new LimitExceededError('lz4.output', maxOutputSize);
    out.set(input.subarray(ip, ip + litLen), op);
    ip += litLen;
    op += litLen;
    if (ip >= inLen) break; // the block's final sequence is literals-only, no trailing match

    if (ip + 2 > inLen) fail('truncated match offset');
    const offset = input[ip]! | (input[ip + 1]! << 8);
    ip += 2;
    if (offset === 0) fail('zero match offset');

    let matchLen = (token & 0xf) + MINMATCH;
    if ((token & 0xf) === 15) matchLen += readExtraLength();
    const matchPos = op - offset;
    if (matchPos < 0) fail(`match offset ${offset} points before the start of the output`);
    if (op + matchLen > maxOutputSize) throw new LimitExceededError('lz4.output', maxOutputSize);
    if (offset >= matchLen) {
      out.copyWithin(op, matchPos, matchPos + matchLen);
    } else {
      // Overlapping copy (offset < length, e.g. run-length-style repeats): must go byte by byte,
      // forward, since `copyWithin`'s semantics for an overlapping forward copy do not match
      // LZ4's "copy already-written output bytes as you go" definition here.
      for (let k = 0; k < matchLen; k++) out[op + k] = out[matchPos + k]!;
    }
    op += matchLen;
  }

  return out.subarray(0, op);
}

// --- frame format: compression -----------------------------------------------------------

export interface Lz4CompressOptions {
  /** Appends the optional 8-byte little-endian content-size field to the frame header. Default
   * `false` (Kafka/HTTP consumers of this package's output never need it). */
  readonly contentSize?: boolean;
}

function headerChecksumByte(flgAndBd: Uint8Array): number {
  return (xxhash32(flgAndBd, 0) >>> 8) & 0xff;
}

/**
 * Compresses `input` into one complete LZ4 **frame**: magic, `FLG`/`BD` descriptor, header
 * checksum, one block per `blockMaxSize`-sized chunk of `input` (always written independent of
 * each other), the end mark, and (always) a whole-content XXH32 checksum.
 */
export function lz4Compress(input: Uint8Array, options: Lz4CompressOptions = {}): Uint8Array {
  const blockMaxSizeIndex = DEFAULT_BLOCK_MAX_SIZE_INDEX;
  const blockMaxSize = BLOCK_MAX_SIZE_BY_INDEX[blockMaxSizeIndex]!;
  const includeContentSize = options.contentSize ?? false;

  // FLG: version=01, block independence=1, block checksum=0, content size=?, content checksum=1,
  // reserved=0, dictionary ID=0.
  const flg = (1 << 6) | (1 << 5) | (includeContentSize ? 1 << 3 : 0) | (1 << 2);
  const bd = blockMaxSizeIndex << 4;
  const descriptor = includeContentSize
    ? (() => {
        const buf = new Uint8Array(10);
        buf[0] = flg;
        buf[1] = bd;
        const view = new DataView(buf.buffer);
        view.setBigUint64(2, BigInt(input.length), true);
        return buf;
      })()
    : Uint8Array.from([flg, bd]);
  const hc = headerChecksumByte(descriptor);

  const parts: Uint8Array[] = [
    Uint8Array.from([
      MAGIC & 0xff,
      (MAGIC >>> 8) & 0xff,
      (MAGIC >>> 16) & 0xff,
      (MAGIC >>> 24) & 0xff,
    ]),
    descriptor,
    Uint8Array.from([hc]),
  ];

  for (let offset = 0; offset < input.length; offset += blockMaxSize) {
    const chunk = input.subarray(offset, Math.min(offset + blockMaxSize, input.length));
    const compressed = lz4CompressBlock(chunk);
    const sizeField = new Uint8Array(4);
    const view = new DataView(sizeField.buffer);
    if (compressed.length < chunk.length) {
      view.setUint32(0, compressed.length, true);
      parts.push(sizeField, compressed);
    } else {
      // Storing the chunk raw is never larger than a worst-case LZ4 encoding and avoids
      // paying literal-run overhead on incompressible data.
      view.setUint32(0, (chunk.length | 0x80000000) >>> 0, true);
      parts.push(sizeField, Uint8Array.from(chunk));
    }
  }
  // Input of length 0 produces zero blocks, which is valid: just the end mark and (if enabled)
  // the content checksum of the empty string follow immediately.

  parts.push(Uint8Array.from([0, 0, 0, 0])); // end mark
  const contentChecksum = new Uint8Array(4);
  new DataView(contentChecksum.buffer).setUint32(0, xxhash32(input, 0), true);
  parts.push(contentChecksum);

  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// --- frame format: decompression ----------------------------------------------------------

export interface Lz4DecompressOptions {
  /** Rejects decompressed output above this many total bytes, checked incrementally (per block
   * and cumulatively) rather than only at the end. Default 512MiB. */
  readonly maxOutputSize?: number;
}

/**
 * Decompresses one complete LZ4 **frame** produced by this module or by any spec-compliant LZ4
 * encoder (verified against the real `lz4` CLI's output — see `test/compression/fixtures/`):
 * handles both block-independent and block-dependent frames (a match offset is always resolved
 * against the whole decompressed-so-far output, so which flag the source frame declared does not
 * change how this decodes it), an optional content-size field, an optional per-block checksum, and
 * an optional whole-content checksum. A frame requesting an external dictionary (`FLG`'s
 * dictionary-ID bit) is rejected — this module does not support LZ4 dictionaries. Never throws
 * anything but a `FerruleError` subclass, however malformed the input.
 */
export function lz4Decompress(input: Uint8Array, options: Lz4DecompressOptions = {}): Uint8Array {
  const maxOutputSize = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT_BYTES;
  try {
    return decompressFrameInner(input, maxOutputSize);
  } catch (error) {
    if (error instanceof FerruleError) throw error;
    fail('unexpected decode failure', error);
  }
}

function decompressFrameInner(input: Uint8Array, maxOutputSize: number): Uint8Array {
  if (input.length < 7) fail('frame shorter than the minimum header');
  const magic = (input[0]! | (input[1]! << 8) | (input[2]! << 16) | (input[3]! << 24)) >>> 0;
  if (magic !== MAGIC) fail(`bad magic number 0x${magic.toString(16)}`);

  let pos = 4;
  const flg = input[pos]!;
  const bd = input[pos + 1]!;
  const version = (flg >>> 6) & 0x3;
  if (version !== 1) fail(`unsupported frame version ${version}`);
  const blockChecksumFlag = ((flg >>> 4) & 1) === 1;
  const contentSizeFlag = ((flg >>> 3) & 1) === 1;
  const contentChecksumFlag = ((flg >>> 2) & 1) === 1;
  const dictIdFlag = (flg & 1) === 1;
  if (dictIdFlag) fail('frame uses an external dictionary, which is not supported');

  const descriptorLength = 2 + (contentSizeFlag ? 8 : 0) + (dictIdFlag ? 4 : 0);
  if (pos + descriptorLength + 1 > input.length) fail('truncated frame descriptor');
  let declaredContentSize: bigint | undefined;
  let cursor = pos + 2;
  if (contentSizeFlag) {
    declaredContentSize = readU64LE(input, cursor);
    cursor += 8;
  }
  const hc = input[cursor]!;
  const computedHc = headerChecksumByte(input.subarray(pos, cursor));
  if (hc !== computedHc) fail('header checksum mismatch');
  pos = cursor + 1;

  const blockMaxSizeIndex = (bd >>> 4) & 0x7;
  const blockMaxSize = BLOCK_MAX_SIZE_BY_INDEX[blockMaxSizeIndex] ?? 0;
  if (blockMaxSize === 0) fail(`invalid block max size index ${blockMaxSizeIndex}`);

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    if (pos + 4 > input.length) fail('truncated block size field');
    const blockSizeField = readU32LE(input, pos);
    pos += 4;
    if (blockSizeField === 0) break; // end mark
    const uncompressed = (blockSizeField & 0x80000000) !== 0;
    const blockSize = blockSizeField & 0x7fffffff;
    if (pos + blockSize > input.length) fail('truncated block data');
    const blockData = input.subarray(pos, pos + blockSize);
    pos += blockSize;
    if (blockChecksumFlag) {
      if (pos + 4 > input.length) fail('truncated block checksum');
      const checksum = readU32LE(input, pos);
      pos += 4;
      if (xxhash32(blockData, 0) !== checksum) fail('block checksum mismatch');
    }

    let decoded: Uint8Array;
    if (uncompressed) {
      if (blockSize > blockMaxSize) fail('raw block exceeds the frame’s declared block size');
      decoded = blockData;
    } else {
      decoded = lz4DecompressBlock(blockData, blockMaxSize);
    }
    totalLength += decoded.length;
    if (totalLength > maxOutputSize) throw new LimitExceededError('lz4.output', maxOutputSize);
    chunks.push(decoded);
  }

  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  if (declaredContentSize !== undefined && BigInt(out.length) !== declaredContentSize) {
    fail(
      `decompressed ${out.length} bytes but the frame declared a content size of ${declaredContentSize}`,
    );
  }

  if (contentChecksumFlag) {
    if (pos + 4 > input.length) fail('truncated content checksum');
    const checksum = readU32LE(input, pos);
    pos += 4;
    if (xxhash32(out, 0) !== checksum) fail('content checksum mismatch');
  }

  return out;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const low = BigInt(readU32LE(data, offset));
  const high = BigInt(readU32LE(data, offset + 4));
  return low | (high << 32n);
}
