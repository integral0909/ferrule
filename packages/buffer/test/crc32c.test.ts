import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { crc32c } from '@ferrule/buffer';

describe('crc32c', () => {
  it('matches the standard "123456789" test vector', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32c(bytes)).toBe(0xe3069283);
  });

  it('is zero for empty input', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  it('produces a stable value for a known buffer', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(crc32c(bytes)).toBe(crc32c(bytes));
    expect(crc32c(bytes)).toBe(36446513);
  });

  it('almost always differs for a single flipped bit', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), fc.nat(), (bytes, seed) => {
        const index = seed % bytes.length;
        const bit = 1 << (seed % 8);
        const flipped = bytes.slice();
        flipped[index] = flipped[index]! ^ bit;
        expect(crc32c(flipped)).not.toBe(crc32c(bytes));
      }),
    );
  });

  it('chains: crc32c(b, crc32c(a)) equals crc32c(concat(a, b))', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), fc.uint8Array({ maxLength: 128 }), (a, b) => {
        const combined = new Uint8Array(a.length + b.length);
        combined.set(a, 0);
        combined.set(b, a.length);
        expect(crc32c(b, crc32c(a))).toBe(crc32c(combined));
      }),
    );
  });

  it('splitting input at any point and chaining always agrees with the whole-buffer checksum', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), fc.nat(), (bytes, seed) => {
        const cut = seed % (bytes.length + 1);
        const a = bytes.subarray(0, cut);
        const b = bytes.subarray(cut);
        expect(crc32c(b, crc32c(a))).toBe(crc32c(bytes));
      }),
    );
  });
});
