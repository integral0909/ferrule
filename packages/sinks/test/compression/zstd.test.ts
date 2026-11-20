import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FerruleError, LimitExceededError } from '@ferrule/core';
import {
  ZSTD_DEFAULT_LEVEL,
  zstdAvailable,
  zstdCompress,
  zstdCompressAsync,
  zstdDecompress,
} from '../../src/compression/zstd.js';
import { logText } from '../support/log-lines.js';

/** Asserts `fn` throws a `FerruleError` carrying exactly `code`. */
function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  expect(() => {
    try {
      fn();
    } catch (error) {
      thrown = error;
      throw error;
    }
  }).toThrow(FerruleError);
  expect((thrown as FerruleError).code).toBe(code);
}

describe('zstd wrapper', () => {
  it('reports the bindings as available on a supported Node', () => {
    expect(zstdAvailable()).toBe(true);
  });

  it('round-trips a payload', () => {
    const input = Buffer.from('the quick brown fox '.repeat(100));
    expect(zstdDecompress(zstdCompress(input))).toEqual(input);
  });

  it('round-trips an empty buffer', () => {
    expect(zstdDecompress(zstdCompress(Buffer.alloc(0)))).toEqual(Buffer.alloc(0));
  });

  it('actually compresses repetitive input', () => {
    const input = Buffer.alloc(64 * 1024, 0x61);
    expect(zstdCompress(input).length).toBeLessThan(input.length / 10);
  });

  it('round-trips arbitrary bytes at every level boundary', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 4096 }),
        fc.constantFrom(1, ZSTD_DEFAULT_LEVEL, 22),
        (bytes, level) => {
          const input = Buffer.from(bytes);
          expect(zstdDecompress(zstdCompress(input, { level }))).toEqual(input);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects a level outside 1..22 with a coded error', () => {
    for (const level of [0, 23, 1.5, Number.NaN]) {
      expectErrorCode(() => zstdCompress(Buffer.from('x'), { level }), 'E_ZSTD_LEVEL');
    }
  });

  it('refuses a frame that expands past maxOutputBytes, before allocating it', () => {
    // 8MiB of zeroes compresses to a few dozen bytes: the classic decompression bomb shape.
    const bomb = zstdCompress(Buffer.alloc(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024);
    expect(() => zstdDecompress(bomb, { maxOutputBytes: 1024 })).toThrow(LimitExceededError);
    try {
      zstdDecompress(bomb, { maxOutputBytes: 1024 });
    } catch (error) {
      expect(error).toBeInstanceOf(LimitExceededError);
      expect((error as LimitExceededError).limit).toBe('zstd.output');
      expect((error as LimitExceededError).max).toBe(1024);
    }
  });

  it('still decompresses a frame that fits exactly within the cap', () => {
    const input = Buffer.alloc(4096, 0x7a);
    expect(zstdDecompress(zstdCompress(input), { maxOutputBytes: 4096 })).toEqual(input);
  });

  it('never throws an untyped error on malformed input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        try {
          zstdDecompress(Buffer.from(bytes));
        } catch (error) {
          expect(error).toBeInstanceOf(FerruleError);
          return;
        }
        // Decoding random bytes without error is acceptable; not crashing untyped is the point.
      }),
      { numRuns: 200 },
    );
  });

  it('reports a truncated frame instead of silently returning short output', () => {
    // zlib.zstdDecompressSync by itself returns zero bytes and no error for these inputs, which
    // would turn a clipped batch into a silently empty one.
    const original = Buffer.from('some reasonably compressible content '.repeat(50));
    const full = zstdCompress(original);
    for (const cut of [1, 4, 10, Math.floor(full.length / 2)]) {
      expectErrorCode(
        () => zstdDecompress(full.subarray(0, full.length - cut)),
        'E_ZSTD_TRUNCATED',
      );
    }
  });

  it('rejects an oversized frame from its declared size, before decompressing', () => {
    const bomb = zstdCompress(Buffer.alloc(8 * 1024 * 1024));
    expect(() => zstdDecompress(bomb, { maxOutputBytes: 64 })).toThrow(LimitExceededError);
  });

  it('decodes every one of several concatenated frames, like the reference CLI', () => {
    // zlib alone returns only the first frame here and silently drops the rest.
    const a = Buffer.from('first frame payload');
    const b = Buffer.from('second frame payload');
    const joined = Buffer.concat([zstdCompress(a), zstdCompress(b)]);
    expect(zstdDecompress(joined)).toEqual(Buffer.concat([a, b]));
  });

  it('applies the output cap to concatenated frames in total, not per frame', () => {
    const part = Buffer.alloc(3000, 0x61);
    const joined = Buffer.concat([zstdCompress(part), zstdCompress(part)]);
    expect(zstdDecompress(joined, { maxOutputBytes: 6000 }).length).toBe(6000);
    expect(() => zstdDecompress(joined, { maxOutputBytes: 5000 })).toThrow(LimitExceededError);
  });

  it('accepts frames that fill the output cap exactly, including a trailing empty frame', () => {
    // Regression: the empty frame was decompressed with maxOutputLength 0, which zlib rejects
    // as out of range, and the valid input was reported as corrupt.
    const full = Buffer.alloc(3000, 0x61);
    const joined = Buffer.concat([zstdCompress(full), zstdCompress(Buffer.alloc(0))]);
    expect(zstdDecompress(joined, { maxOutputBytes: 3000 })).toEqual(full);
  });

  it('zstdCompressAsync round-trips and honours the level', async () => {
    const input = logText(300, 6);
    const fast = await zstdCompressAsync(input, { level: 1 });
    const small = await zstdCompressAsync(input, { level: 19 });
    expect(zstdDecompress(fast).equals(input)).toBe(true);
    expect(zstdDecompress(small).equals(input)).toBe(true);
    expect(small.length).toBeLessThan(fast.length);
  });

  it('zstdCompressAsync rejects a bad level synchronously, before queueing work', () => {
    expectErrorCode(() => zstdCompressAsync(Buffer.from('x'), { level: 0 }), 'E_ZSTD_LEVEL');
  });

  it('skips skippable frames', () => {
    const skippable = Buffer.alloc(8 + 5);
    skippable.writeUInt32LE(0x184d2a5a, 0);
    skippable.writeUInt32LE(5, 4);
    const payload = Buffer.from('after the skippable frame');
    expect(zstdDecompress(Buffer.concat([skippable, zstdCompress(payload)]))).toEqual(payload);
  });

  it('rejects trailing bytes that are not a frame', () => {
    const framed = zstdCompress(Buffer.from('payload'));
    expectErrorCode(
      () => zstdDecompress(Buffer.concat([framed, Buffer.from([1, 2])])),
      'E_ZSTD_TRUNCATED',
    );
    expectErrorCode(
      () => zstdDecompress(Buffer.concat([framed, Buffer.from([1, 2, 3, 4, 5])])),
      'E_ZSTD_CORRUPT',
    );
  });

  it('reports empty input as truncated', () => {
    expectErrorCode(() => zstdDecompress(Buffer.alloc(0)), 'E_ZSTD_TRUNCATED');
  });

  it('round-trips sizes spanning every frame-content-size encoding width', () => {
    // 1-byte, 2-byte and 4-byte Frame_Content_Size forms respectively.
    for (const size of [0, 1, 100, 255, 256, 1850, 65_791, 70_000, 300_000]) {
      const input = Buffer.alloc(size, 0x61);
      expect(zstdDecompress(zstdCompress(input)).length).toBe(size);
    }
  });
});
