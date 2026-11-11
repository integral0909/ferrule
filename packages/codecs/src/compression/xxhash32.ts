/**
 * xxHash32 (<https://github.com/Cyan4973/xxHash>, the "XXH32" variant), a non-cryptographic hash
 * used here only for the LZ4 frame format's header/block/content checksums (`lz4.ts`) — the LZ4
 * frame spec mandates XXH32 with seed `0` for exactly that purpose, so a from-scratch LZ4
 * implementation needs its own XXH32 rather than pulling in a dependency for one hash function.
 *
 * This is a direct, portable transliteration of the reference one-shot algorithm (no SIMD, no
 * streaming state) over a `Uint8Array`/`Buffer`. Every arithmetic step uses `Math.imul`/`>>> 0` to
 * keep intermediate values exact 32-bit unsigned wraps, the same way `@ferrule/buffer`'s `crc32c`
 * keeps its accumulator an exact `uint32`.
 */

const PRIME32_1 = 2654435761;
const PRIME32_2 = 2246822519;
const PRIME32_3 = 3266489917;
const PRIME32_4 = 668265263;
const PRIME32_5 = 374761393;

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function round(acc: number, input: number): number {
  acc = (acc + Math.imul(input, PRIME32_2)) >>> 0;
  acc = rotl32(acc, 13);
  return Math.imul(acc, PRIME32_1) >>> 0;
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

/**
 * Computes the XXH32 digest of `data` with the given `seed` (default `0`, matching the LZ4 frame
 * format's own default). Verified against the LZ4 frame format's own test fixtures (see
 * `test/compression/lz4.test.ts` and `test/compression/fixtures/README.md`): the header, block,
 * and content checksums of every `.lz4` file produced by the reference `lz4` CLI in that
 * directory were independently reproduced by this function, which exercises both the `>= 16`-byte
 * bulk path and the short-input tail path. `XXH32("", 0) === 0x02cc5d05` (reproduced by
 * `empty.lz4`'s content checksum) is also the published reference digest for the empty string.
 */
export function xxhash32(data: Uint8Array, seed = 0): number {
  const len = data.length;
  let offset = 0;
  let h32: number;

  if (len >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;
    const limit = len - 16;
    while (offset <= limit) {
      v1 = round(v1, readU32LE(data, offset));
      offset += 4;
      v2 = round(v2, readU32LE(data, offset));
      offset += 4;
      v3 = round(v3, readU32LE(data, offset));
      offset += 4;
      v4 = round(v4, readU32LE(data, offset));
      offset += 4;
    }
    h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    h32 = (seed + PRIME32_5) >>> 0;
  }

  h32 = (h32 + len) >>> 0;

  while (offset + 4 <= len) {
    h32 = (h32 + Math.imul(readU32LE(data, offset), PRIME32_3)) >>> 0;
    h32 = Math.imul(rotl32(h32, 17), PRIME32_4) >>> 0;
    offset += 4;
  }
  while (offset < len) {
    h32 = (h32 + Math.imul(data[offset]!, PRIME32_5)) >>> 0;
    h32 = Math.imul(rotl32(h32, 11), PRIME32_1) >>> 0;
    offset += 1;
  }

  h32 ^= h32 >>> 15;
  h32 = Math.imul(h32, PRIME32_2) >>> 0;
  h32 ^= h32 >>> 13;
  h32 = Math.imul(h32, PRIME32_3) >>> 0;
  h32 ^= h32 >>> 16;
  return h32 >>> 0;
}
