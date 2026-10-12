import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { xxhash32 } from '@ferrule/codecs';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('xxhash32', () => {
  it('matches the published XXH32("", seed=0) digest', () => {
    // 0x02cc5d05 is XXH32's well-known published digest of the empty string; it is also exactly
    // the content checksum the reference `lz4` CLI wrote into `fixtures/empty.lz4` (see that
    // directory's README), so this one assertion is both a published-vector check and a
    // real-world interop check at once.
    expect(xxhash32(new Uint8Array(0), 0)).toBe(0x02cc5d05);
  });

  it('is seed-sensitive for the empty string', () => {
    expect(xxhash32(new Uint8Array(0), 1)).not.toBe(xxhash32(new Uint8Array(0), 0));
  });

  // Four more digests, computed by a completely independent implementation (the reference `lz4`
  // CLI's own XXH32), over real non-trivial content: the frame content checksum each one wrote
  // is read directly from the fixture's trailing 4 bytes (little-endian) below, not hand-copied,
  // so there's no chance of transcribing the "expected" value wrong.
  for (const [lz4File, txtFile] of [
    ['hello.lz4', 'hello.txt'],
    ['repeated.lz4', 'repeated.txt'],
    ['random.lz4', 'random.bin'],
    ['multiblock.lz4', 'multiblock.txt'],
  ] as const) {
    it(`matches the reference lz4 CLI's content checksum for ${txtFile}`, () => {
      const frame = readFileSync(join(fixturesDir, lz4File));
      const expected = frame.readUInt32LE(frame.length - 4);
      const content = readFileSync(join(fixturesDir, txtFile));
      expect(xxhash32(content, 0)).toBe(expected);
    });
  }

  it('almost always differs for a single flipped bit', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), fc.nat(), (bytes, seed) => {
        const index = seed % bytes.length;
        const bit = 1 << (seed % 8);
        const flipped = bytes.slice();
        flipped[index] = flipped[index]! ^ bit;
        expect(xxhash32(flipped)).not.toBe(xxhash32(bytes));
      }),
    );
  });

  it('is deterministic for a given input and seed', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.nat(0xffffffff), (bytes, seed) => {
        expect(xxhash32(bytes, seed)).toBe(xxhash32(bytes, seed));
      }),
    );
  });

  it('always returns an unsigned 32-bit integer', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.nat(0xffffffff), (bytes, seed) => {
        const h = xxhash32(bytes, seed);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(0xffffffff);
        expect(Number.isInteger(h)).toBe(true);
      }),
    );
  });
});
