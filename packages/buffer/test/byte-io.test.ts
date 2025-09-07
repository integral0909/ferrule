import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  CodecLimitExceededError,
  CodecMalformedError,
  CodecTruncatedError,
} from '@ferrule/buffer';

describe('ByteWriter / ByteReader', () => {
  it('round-trips uint8/uint32/uint64/float64', () => {
    const w = new ByteWriter();
    w.writeUint8(0xab);
    w.writeUint32LE(0xdeadbeef);
    w.writeUint64LE(0x0123456789abcdefn);
    w.writeFloat64LE(3.5);
    w.writeFloat64LE(-0);
    w.writeFloat64LE(NaN);
    const r = new ByteReader(w.toUint8Array());
    expect(r.readUint8()).toBe(0xab);
    expect(r.readUint32LE()).toBe(0xdeadbeef);
    expect(r.readUint64LE()).toBe(0x0123456789abcdefn);
    expect(r.readFloat64LE()).toBe(3.5);
    expect(Object.is(r.readFloat64LE(), -0)).toBe(true);
    expect(Number.isNaN(r.readFloat64LE())).toBe(true);
    expect(r.atEnd()).toBe(true);
  });

  it('grows its internal buffer past the initial capacity', () => {
    const w = new ByteWriter(4);
    const bytes = new Uint8Array(10_000).map((_, i) => i & 0xff);
    w.writeRawBytes(bytes);
    expect(w.toUint8Array()).toEqual(bytes);
  });

  it('round-trips arbitrary non-negative safe integers as varints', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        const w = new ByteWriter();
        w.writeVarint(n);
        const r = new ByteReader(w.toUint8Array());
        expect(r.readVarint()).toBe(n);
        expect(r.atEnd()).toBe(true);
      }),
    );
  });

  it('rejects negative or non-safe-integer varints', () => {
    const w = new ByteWriter();
    expect(() => w.writeVarint(-1)).toThrow(RangeError);
    expect(() => w.writeVarint(1.5)).toThrow(RangeError);
  });

  it('round-trips arbitrary uint64 values as unsigned bigint varints', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (n) => {
        const w = new ByteWriter();
        w.writeVarintBig(n);
        const r = new ByteReader(w.toUint8Array());
        expect(r.readVarintBig()).toBe(n);
      }),
    );
  });

  it('round-trips arbitrary int64 values through zigzag', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n }), (n) => {
        const w = new ByteWriter();
        w.writeZigzagBig(n);
        const r = new ByteReader(w.toUint8Array());
        expect(r.readZigzagBig()).toBe(n);
      }),
    );
  });

  it('zigzag keeps small-magnitude negative numbers compact', () => {
    const w = new ByteWriter();
    w.writeZigzagBig(-1n);
    expect(w.length).toBe(1);
  });

  it('round-trips length-prefixed bytes and strings', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        (bytes, text) => {
          const w = new ByteWriter();
          w.writeLengthPrefixed(bytes);
          w.writeString(text);
          const r = new ByteReader(w.toUint8Array());
          expect(r.readLengthPrefixed()).toEqual(bytes);
          expect(r.readString()).toBe(text);
        },
      ),
    );
  });

  it('throws CodecTruncatedError when reading past the end', () => {
    const r = new ByteReader(new Uint8Array([1, 2]));
    r.readUint8();
    r.readUint8();
    expect(() => r.readUint8()).toThrow(CodecTruncatedError);
    expect(() => new ByteReader(new Uint8Array(3)).readUint64LE()).toThrow(CodecTruncatedError);
  });

  it('throws CodecLimitExceededError when a length exceeds the configured limit', () => {
    const w = new ByteWriter();
    w.writeLengthPrefixed(new Uint8Array(100));
    const r = new ByteReader(w.toUint8Array());
    expect(() => r.readLengthPrefixed(10)).toThrow(CodecLimitExceededError);
  });

  it('throws CodecMalformedError for an unterminated (too-long) varint', () => {
    const bytes = new Uint8Array(11).fill(0x80); // continuation bit always set
    expect(() => new ByteReader(bytes).readVarint()).toThrow(CodecMalformedError);
    expect(() => new ByteReader(bytes).readVarintBig()).toThrow(CodecMalformedError);
  });

  it('throws CodecMalformedError when a varint would exceed the safe integer range', () => {
    // 10 bytes, each with 7 low bits set and the continuation bit on the first 9 — encodes a
    // value with 70 significant bits, far beyond Number.MAX_SAFE_INTEGER.
    const bytes = new Uint8Array(10).fill(0xff);
    bytes[9] = 0x7f;
    expect(() => new ByteReader(bytes).readVarint()).toThrow(CodecMalformedError);
  });

  it('never throws anything but a CodecTruncatedError/CodecMalformedError/CodecLimitExceededError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.nat({ max: 7 }), (bytes, op) => {
        const r = new ByteReader(bytes, { maxLength: 8 });
        try {
          switch (op) {
            case 0:
              r.readUint8();
              break;
            case 1:
              r.readUint32LE();
              break;
            case 2:
              r.readUint64LE();
              break;
            case 3:
              r.readFloat64LE();
              break;
            case 4:
              r.readVarint();
              break;
            case 5:
              r.readVarintBig();
              break;
            case 6:
              r.readLengthPrefixed();
              break;
            default:
              r.readString();
              break;
          }
        } catch (error) {
          expect(
            error instanceof CodecTruncatedError ||
              error instanceof CodecMalformedError ||
              error instanceof CodecLimitExceededError,
          ).toBe(true);
        }
      }),
    );
  });
});
