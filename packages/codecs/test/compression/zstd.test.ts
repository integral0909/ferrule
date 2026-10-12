import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FerruleError, LimitExceededError } from '@ferrule/core';
import {
  isZstdSupported,
  zstdCompress,
  zstdDecompress,
  zstdUnsupportedMessage,
} from '@ferrule/codecs';

// This suite runs on whatever Node version executes the test suite. `@ferrule/codecs`'s
// `engines.node` floor (>=22.12.0) is slightly below the version zstd support landed in
// (22.15.0/23.8.0 — see `zstd.ts`'s doc comment), so `isZstdSupported()` is not guaranteed `true`
// here; every test below either skips cleanly when it's `false` or exercises the
// always-available "unsupported" error path (`zstd-unsupported.test.ts` forces that path on any
// runtime, by mocking `node:zlib`, so the `E_ZSTD_UNSUPPORTED` behavior itself is still verified
// unconditionally).

describe('isZstdSupported', () => {
  it('returns a boolean', () => {
    expect(typeof isZstdSupported()).toBe('boolean');
  });
});

describe('zstdUnsupportedMessage', () => {
  it('names the required Node.js version', () => {
    expect(zstdUnsupportedMessage()).toContain('22.15.0');
    expect(zstdUnsupportedMessage()).toContain('Node.js');
  });
});

describe.runIf(isZstdSupported())(
  'zstdCompress / zstdDecompress (this runtime supports zstd)',
  () => {
    it('round-trips the empty input', () => {
      const compressed = zstdCompress(new Uint8Array(0));
      expect(zstdDecompress(compressed)).toEqual(Buffer.alloc(0));
    });

    it('round-trips arbitrary buffers (property)', () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 4096 }), (input) => {
          const compressed = zstdCompress(input);
          const decompressed = zstdDecompress(compressed);
          expect(decompressed).toEqual(Buffer.from(input));
        }),
        { numRuns: 100 },
      );
    });

    it('compresses a highly repetitive buffer to a fraction of its size', () => {
      const input = new Uint8Array(8192).fill(65);
      const compressed = zstdCompress(input);
      expect(compressed.length).toBeLessThan(input.length / 10);
    });

    it('never throws anything other than a FerruleError when decompressing arbitrary bytes', () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 256 }), (input) => {
          try {
            zstdDecompress(input);
          } catch (error) {
            expect(error).toBeInstanceOf(FerruleError);
          }
        }),
        { numRuns: 300 },
      );
    });

    it('rejects output above the configured bound', () => {
      const input = new Uint8Array(4096).fill(1);
      const compressed = zstdCompress(input);
      expect(() => zstdDecompress(compressed, { maxOutputSize: 10 })).toThrow(LimitExceededError);
    });
  },
);
