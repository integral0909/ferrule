import type * as Zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// Forces the "this runtime has no zstd support" path unconditionally, regardless of which Node
// version actually runs this suite, by mocking `node:zlib` to hide `zstdCompressSync`/
// `zstdDecompressSync` the same way a Node build older than 22.15.0/23.8.0 would. A separate test
// file (rather than a block inside `zstd.test.ts`) because `vi.mock` is hoisted to the top of the
// module and applies for this whole file's imports.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof Zlib>();
  return { ...actual, zstdCompressSync: undefined, zstdDecompressSync: undefined };
});

describe('zstd on a runtime without zstd support', () => {
  it('isZstdSupported() is false', async () => {
    const { isZstdSupported } = await import('@ferrule/codecs');
    expect(isZstdSupported()).toBe(false);
  });

  it('zstdCompress throws a FerruleError naming the required Node version', async () => {
    const { zstdCompress, zstdUnsupportedMessage } = await import('@ferrule/codecs');
    const { FerruleError } = await import('@ferrule/core');
    try {
      zstdCompress(new Uint8Array(0));
      expect.unreachable('zstdCompress should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FerruleError);
      expect((error as InstanceType<typeof FerruleError>).code).toBe('E_ZSTD_UNSUPPORTED');
      expect((error as Error).message).toBe(zstdUnsupportedMessage());
      expect((error as Error).message).toContain('22.15.0');
    }
  });

  it('zstdDecompress throws a FerruleError naming the required Node version', async () => {
    const { zstdDecompress } = await import('@ferrule/codecs');
    const { FerruleError } = await import('@ferrule/core');
    try {
      zstdDecompress(new Uint8Array(0));
      expect.unreachable('zstdDecompress should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FerruleError);
      expect((error as InstanceType<typeof FerruleError>).code).toBe('E_ZSTD_UNSUPPORTED');
    }
  });
});
