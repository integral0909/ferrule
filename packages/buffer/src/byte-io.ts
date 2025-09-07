import { utf8Decode, utf8Encode } from '@ferrule/core';
import { CodecLimitExceededError, CodecMalformedError, CodecTruncatedError } from './errors.js';

/**
 * A growable little-endian byte buffer used to build binary encodings (see `FORMAT.md`).
 *
 * Integers are written with LEB128 "varint" encoding: 7 payload bits per byte, the high bit
 * marking continuation. Signed values are first mapped to an unsigned representation with
 * zigzag encoding (`0, -1, 1, -2, 2, ... -> 0, 1, 2, 3, 4, ...`) so small magnitudes (positive
 * or negative) stay compact.
 */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  writeUint8(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }

  writeUint32LE(value: number): void {
    this.ensure(4);
    const b = this.buf;
    let l = this.len;
    b[l++] = value & 0xff;
    b[l++] = (value >>> 8) & 0xff;
    b[l++] = (value >>> 16) & 0xff;
    b[l++] = (value >>> 24) & 0xff;
    this.len = l;
  }

  writeUint64LE(value: bigint): void {
    this.ensure(8);
    let v = value;
    const b = this.buf;
    let l = this.len;
    for (let i = 0; i < 8; i++) {
      b[l++] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.len = l;
  }

  writeFloat64LE(value: number): void {
    this.ensure(8);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8);
    view.setFloat64(0, value, true);
    this.len += 8;
  }

  /** Writes raw bytes with no length prefix. */
  writeRawBytes(bytes: Uint8Array): void {
    this.ensure(bytes.byteLength);
    this.buf.set(bytes, this.len);
    this.len += bytes.byteLength;
  }

  /** Unsigned LEB128 varint. `value` must be a non-negative safe integer. */
  writeVarint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`writeVarint requires a non-negative safe integer, got ${value}`);
    }
    let v = value;
    for (;;) {
      const byte = v & 0x7f;
      v = Math.floor(v / 128);
      if (v === 0) {
        this.writeUint8(byte);
        return;
      }
      this.writeUint8(byte | 0x80);
    }
  }

  /** Unsigned LEB128 varint over a bigint. `value` must be non-negative. */
  writeVarintBig(value: bigint): void {
    if (value < 0n) {
      throw new RangeError(`writeVarintBig requires a non-negative value, got ${value}`);
    }
    let v = value;
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v === 0n) {
        this.writeUint8(byte);
        return;
      }
      this.writeUint8(byte | 0x80);
    }
  }

  /** Zigzag-encodes a signed bigint, then writes it as an unsigned varint. */
  writeZigzagBig(value: bigint): void {
    this.writeVarintBig(value >= 0n ? value << 1n : (-value << 1n) - 1n);
  }

  /** Varint length prefix followed by the raw bytes. */
  writeLengthPrefixed(bytes: Uint8Array): void {
    this.writeVarint(bytes.byteLength);
    this.writeRawBytes(bytes);
  }

  writeString(text: string): void {
    this.writeLengthPrefixed(utf8Encode(text));
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Optional bounds a {@link ByteReader} enforces on length-prefixed fields. */
export interface ReaderLimits {
  /** Maximum accepted value for any single varint-encoded length or count. Default 64 MiB. */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 64 * 1024 * 1024;
/** LEB128 varints wider than this many bytes cannot hold a value within `maxLength`. */
const MAX_VARINT_BYTES = 10;

/**
 * Reads the binary format written by {@link ByteWriter}. Every read method throws a typed
 * error (never a bare `RangeError` or similar) when the input is exhausted or malformed, so
 * callers decoding untrusted data never see anything but `FerruleError` subclasses.
 */
export class ByteReader {
  private pos = 0;
  private readonly maxLength: number;

  constructor(
    private readonly data: Uint8Array,
    limits: ReaderLimits = {},
  ) {
    this.maxLength = limits.maxLength ?? DEFAULT_MAX_LENGTH;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.byteLength - this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.data.byteLength;
  }

  private need(n: number): void {
    if (this.remaining < n) {
      throw new CodecTruncatedError(
        `expected ${n} more byte(s) at offset ${this.pos}, found ${Math.max(this.remaining, 0)}`,
      );
    }
  }

  readUint8(): number {
    this.need(1);
    return this.data[this.pos++]!;
  }

  readUint32LE(): number {
    this.need(4);
    const d = this.data;
    let p = this.pos;
    const value = d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24);
    p += 4;
    this.pos = p;
    return value >>> 0;
  }

  readUint64LE(): bigint {
    this.need(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) {
      value = (value << 8n) | BigInt(this.data[this.pos + i]!);
    }
    this.pos += 8;
    return value;
  }

  readFloat64LE(): number {
    this.need(8);
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  /** Returns a copy of `n` raw bytes (safe to retain independently of the source buffer). */
  readRawBytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readVarint(): number {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = this.readUint8();
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) {
          throw new CodecMalformedError('varint exceeds the safe integer range');
        }
        return result;
      }
      multiplier *= 128;
    }
    throw new CodecMalformedError('varint is too long (more than 10 continuation bytes)');
  }

  readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = this.readUint8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new CodecMalformedError('varint is too long (more than 10 continuation bytes)');
  }

  readZigzagBig(): bigint {
    const encoded = this.readVarintBig();
    return (encoded & 1n) === 0n ? encoded >> 1n : -((encoded + 1n) >> 1n);
  }

  /** Reads a varint length prefix (bounded by `maxLength` or `limit`) followed by that many bytes. */
  readLengthPrefixed(limit?: number): Uint8Array {
    const length = this.readVarint();
    const max = limit ?? this.maxLength;
    if (length > max) throw new CodecLimitExceededError('field.length', max);
    return this.readRawBytes(length);
  }

  /**
   * Reads a length-prefixed UTF-8 string. Invalid UTF-8 (possible on untrusted input; core's
   * strict decoder rejects it rather than silently substituting U+FFFD) is reported as a
   * {@link CodecMalformedError} — the same error family as every other malformed-input case in
   * this module — rather than leaking core's own `ParseError` type.
   */
  readString(limit?: number): string {
    const bytes = this.readLengthPrefixed(limit);
    try {
      return utf8Decode(bytes, 'strict');
    } catch (error) {
      throw new CodecMalformedError(
        `invalid UTF-8 in string field: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
