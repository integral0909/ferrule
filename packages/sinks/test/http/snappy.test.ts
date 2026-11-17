import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FerruleError } from '@ferrule/core';
import { snappyCompress, snappyDecompress } from '../../src/http/snappy.js';

/**
 * Byte-equality for *large* buffers. `expect(a).toEqual(b)` walks two `Uint8Array`s element by
 * element through the structural-equality/diff machinery: on a 200 KB pair that takes over a
 * second (against a 5s per-test timeout, which parallel suite load then pushes over), while the
 * compression it is checking takes ~20ms. `Buffer.equals` is a memcmp and does the same job in
 * about a millisecond; the index of the first difference is reported by hand, since a raw
 * boolean comparison would otherwise fail with no clue where.
 *
 * Small buffers elsewhere in this file keep plain `toEqual`, whose diff output is worth having.
 */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  if (Buffer.from(actual).equals(Buffer.from(expected))) return;
  expect(actual.byteLength).toBe(expected.byteLength);
  const at = actual.findIndex((byte, i) => byte !== expected[i]);
  throw new Error(
    `buffers differ at byte ${at}: got 0x${actual[at]!.toString(16)}, expected 0x${expected[at]!.toString(16)}`,
  );
}

describe('snappy round trip', () => {
  it('round-trips the empty buffer', () => {
    const compressed = snappyCompress(new Uint8Array(0));
    expect(snappyDecompress(compressed)).toEqual(new Uint8Array(0));
  });

  it('round-trips a small literal-only buffer', () => {
    const input = new TextEncoder().encode('hello, snappy!');
    const compressed = snappyCompress(input);
    expect(snappyDecompress(compressed)).toEqual(input);
  });

  it('round-trips highly repetitive data and actually compresses it', () => {
    const input = new TextEncoder().encode('abcdefgh'.repeat(2000));
    const compressed = snappyCompress(input);
    expect(snappyDecompress(compressed)).toEqual(input);
    expect(compressed.byteLength).toBeLessThan(input.byteLength / 4);
  });

  it('round-trips data with an overlapping run-length pattern (offset < match length)', () => {
    // "aaaaaaaa..." forces the compressor to encode a copy whose source region overlaps the
    // region being written (offset 1, length > 1), exercising the byte-by-byte overlap semantics.
    const input = new Uint8Array(5000).fill(0x61);
    const compressed = snappyCompress(input);
    expect(snappyDecompress(compressed)).toEqual(input);
  });

  it('round-trips a buffer long enough to require a multi-byte literal length and chunked copies', () => {
    const random = new Uint8Array(200_000);
    for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) & 0xff;
    const compressed = snappyCompress(random);
    expectBytesEqual(snappyDecompress(compressed), random);
  });

  it('round-trips arbitrary buffers (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (input) => {
        const compressed = snappyCompress(input);
        const decompressed = snappyDecompress(compressed);
        expect(decompressed).toEqual(input);
      }),
      { numRuns: 200 },
    );
  });
});

describe('snappyDecompress on malformed input', () => {
  it('never throws anything other than a FerruleError, for arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (input) => {
        try {
          snappyDecompress(input);
        } catch (error) {
          expect(error).toBeInstanceOf(FerruleError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('rejects a declared length above maxOutputBytes without allocating', () => {
    // varint-encoded huge length (0xFFFFFFFF), no body.
    const huge = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]);
    expect(() => snappyDecompress(huge, { maxOutputBytes: 1024 })).toThrow(FerruleError);
  });

  it('rejects a copy whose offset points before the start of the output', () => {
    // preamble length=1, then a 2-byte-offset copy tag requesting offset 5 with nothing written yet.
    const bytes = Uint8Array.from([0x01, 0x06, 0x05, 0x00]);
    expect(() => snappyDecompress(bytes)).toThrow(FerruleError);
  });

  it('rejects a truncated literal', () => {
    // preamble length=10, literal tag claims 10 bytes, but none follow.
    const bytes = Uint8Array.from([0x0a, (10 - 1) << 2]);
    expect(() => snappyDecompress(bytes)).toThrow(FerruleError);
  });
});
