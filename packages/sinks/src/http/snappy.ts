import { FerruleError, LimitExceededError } from '@ferrule/core';

/**
 * A hand-written implementation of the Snappy "block format" (as documented in
 * https://github.com/google/snappy/blob/main/format_description.txt), used by the
 * `prometheus_remote_write` sink — Prometheus's remote-write protocol requires the protobuf
 * `WriteRequest` body to be Snappy-compressed, and there is no third-party dependency available
 * to do that here.
 *
 * The compressor is a straightforward LZ77 matcher over a rolling hash of 4-byte windows (not
 * the most aggressive possible Snappy encoder, but every element it emits — literals and the
 * three copy forms — follows the format exactly, so any spec-compliant Snappy decoder can read
 * its output). The decompressor accepts anything a spec-compliant encoder could produce
 * (including plain literal-only streams) and never throws anything other than a `FerruleError`
 * subclass, however malformed the input.
 */

const MAX_LITERAL_CHUNK = 1 << 16;
const MAX_COPY_CHUNK = 64;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MIN_MATCH = 4;

// --- varint preamble (Snappy's own length prefix: unsigned LEB128, same shape as protobuf's) ---

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
}

function readVarint(input: Uint8Array, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (let i = 0; i < 5; i++) {
    if (p >= input.length) {
      throw new FerruleError('E_SNAPPY_TRUNCATED', 'truncated snappy length preamble');
    }
    const byte = input[p]!;
    p++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: p };
    shift += 7;
  }
  throw new FerruleError('E_SNAPPY_TRUNCATED', 'snappy length preamble longer than 5 bytes');
}

// --- compression ---------------------------------------------------------------------------

function hash4(input: Uint8Array, pos: number): number {
  const v =
    (input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16) | (input[pos + 3]! << 24)) >>>
    0;
  return (Math.imul(v, 2654435761) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1);
}

function matches4(input: Uint8Array, a: number, b: number): boolean {
  return (
    input[a] === input[b] &&
    input[a + 1] === input[b + 1] &&
    input[a + 2] === input[b + 2] &&
    input[a + 3] === input[b + 3]
  );
}

function writeLiteral(out: number[], input: Uint8Array, start: number, end: number): void {
  let p = start;
  while (p < end) {
    const len = Math.min(end - p, MAX_LITERAL_CHUNK);
    if (len <= 60) {
      out.push(((len - 1) << 2) | 0x00);
    } else {
      const bytes: number[] = [];
      let n = len - 1;
      while (n > 0) {
        bytes.push(n & 0xff);
        n >>>= 8;
      }
      out.push(((59 + bytes.length) << 2) | 0x00);
      for (const b of bytes) out.push(b);
    }
    for (let i = 0; i < len; i++) out.push(input[p + i]!);
    p += len;
  }
}

function writeCopies(out: number[], offset: number, length: number): void {
  let remaining = length;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_COPY_CHUNK);
    if (offset <= 0xffff) {
      out.push(0x02 | ((chunk - 1) << 2));
      out.push(offset & 0xff, (offset >>> 8) & 0xff);
    } else {
      out.push(0x03 | ((chunk - 1) << 2));
      out.push(
        offset & 0xff,
        (offset >>> 8) & 0xff,
        (offset >>> 16) & 0xff,
        (offset >>> 24) & 0xff,
      );
    }
    remaining -= chunk;
  }
}

/** Compresses `input` into a Snappy block-format buffer. */
export function snappyCompress(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  writeVarint(out, input.length);

  const n = input.length;
  const table = new Int32Array(HASH_SIZE).fill(-1);
  let literalStart = 0;
  let i = 0;

  while (i + MIN_MATCH <= n) {
    const h = hash4(input, i);
    const candidate = table[h]!;
    table[h] = i;
    if (candidate >= 0 && matches4(input, candidate, i)) {
      let matchLen = MIN_MATCH;
      const maxLen = n - i;
      while (matchLen < maxLen && input[candidate + matchLen] === input[i + matchLen]) matchLen++;
      writeLiteral(out, input, literalStart, i);
      writeCopies(out, i - candidate, matchLen);
      // Refresh the hash table at a few points across the match so later positions can still
      // find it as a candidate, without paying to index every single byte of a long match.
      const step = matchLen > 32 ? 4 : 1;
      for (let p = i + 1; p < i + matchLen && p + MIN_MATCH <= n; p += step) {
        table[hash4(input, p)] = p;
      }
      i += matchLen;
      literalStart = i;
      continue;
    }
    i++;
  }
  writeLiteral(out, input, literalStart, n);
  return Uint8Array.from(out);
}

// --- decompression --------------------------------------------------------------------------

export interface SnappyDecompressOptions {
  /** Rejects a declared uncompressed length above this many bytes, before allocating. Default 512MiB. */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 512 * 1024 * 1024;

/**
 * Decompresses a Snappy block-format buffer. Bounded and defensive throughout: every input
 * access is range-checked and every failure raises a `FerruleError` (`E_SNAPPY_*`), never an
 * uncaught `RangeError`/`TypeError` from indexing past the end of a malformed buffer.
 */
export function snappyDecompress(
  input: Uint8Array,
  options: SnappyDecompressOptions = {},
): Uint8Array {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  try {
    return decompressInner(input, maxOutputBytes);
  } catch (error) {
    if (error instanceof FerruleError) throw error;
    throw new FerruleError('E_SNAPPY_CORRUPT', 'corrupt snappy stream', { cause: error });
  }
}

function decompressInner(input: Uint8Array, maxOutputBytes: number): Uint8Array {
  const { value: length, next } = readVarint(input, 0);
  if (length > maxOutputBytes) throw new LimitExceededError('snappy.output', maxOutputBytes);
  const out = new Uint8Array(length);
  let outPos = 0;
  let pos = next;

  while (pos < input.length) {
    const tag = input[pos]!;
    pos++;
    const type = tag & 0x03;
    if (type === 0x00) {
      const upper = tag >>> 2;
      let litLen: number;
      if (upper <= 59) {
        litLen = upper + 1;
      } else {
        const count = upper - 59;
        if (pos + count > input.length) fail('truncated literal length');
        let val = 0;
        for (let k = 0; k < count; k++) val |= input[pos + k]! << (8 * k);
        pos += count;
        litLen = (val >>> 0) + 1;
      }
      if (pos + litLen > input.length) fail('truncated literal body');
      if (outPos + litLen > out.length) fail('literal overruns declared output length');
      out.set(input.subarray(pos, pos + litLen), outPos);
      pos += litLen;
      outPos += litLen;
      continue;
    }

    let length2: number;
    let offset: number;
    if (type === 0x01) {
      length2 = ((tag >>> 2) & 0x07) + 4;
      if (pos >= input.length) fail('truncated 1-byte-offset copy');
      offset = (((tag >>> 5) & 0x07) << 8) | input[pos]!;
      pos += 1;
    } else if (type === 0x02) {
      length2 = (tag >>> 2) + 1;
      if (pos + 2 > input.length) fail('truncated 2-byte-offset copy');
      offset = input[pos]! | (input[pos + 1]! << 8);
      pos += 2;
    } else {
      length2 = (tag >>> 2) + 1;
      if (pos + 4 > input.length) fail('truncated 4-byte-offset copy');
      offset =
        (input[pos]! |
          (input[pos + 1]! << 8) |
          (input[pos + 2]! << 16) |
          (input[pos + 3]! << 24)) >>>
        0;
      pos += 4;
    }
    if (offset === 0 || offset > outPos) {
      fail(`invalid copy offset ${offset} at output position ${outPos}`);
    }
    if (outPos + length2 > out.length) fail('copy overruns declared output length');
    const srcPos = outPos - offset;
    for (let k = 0; k < length2; k++) out[outPos + k] = out[srcPos + k]!;
    outPos += length2;
  }

  if (outPos !== length) fail(`decompressed ${outPos} bytes but preamble declared ${length}`);
  return out;
}

function fail(message: string): never {
  throw new FerruleError('E_SNAPPY_CORRUPT', `corrupt snappy stream: ${message}`);
}
