import * as zlib from 'node:zlib';
import { FerruleError, LimitExceededError } from '@ferrule/core';

/**
 * zstd support via `node:zlib`'s own `zstdCompressSync`/`zstdDecompressSync` (added in Node.js
 * 22.15.0/23.8.0) — unlike LZ4, zstd needs no hand-written implementation here, since Node's
 * standard library already provides it and `CONTRIBUTING.md`'s dependency policy prefers the
 * standard library over a third-party dependency whenever one already covers the need.
 *
 * `engines.node` for this monorepo is `>=22.12.0`, which is slightly *below* the version zstd
 * landed in, so a runtime between 22.12.0 and 22.15.0 (or any Node 23 build before 23.8.0) does
 * not have it. {@link isZstdSupported} feature-detects this at runtime rather than assuming the
 * engines floor guarantees it; every sink option schema that exposes a `zstd` compression choice
 * validates {@link isZstdSupported} at config-validation time (see `kafka/sink.ts`'s and
 * `http/schema.ts`'s `.refine(...)`) so a user who picks `zstd` on an unsupported runtime gets a
 * clear error naming the required Node version, rather than a crash the first time a batch
 * happens to compress.
 */

export const ZSTD_MIN_NODE_VERSION = '22.15.0 (or 23.8.0 on the Node 23 line)';

/** Whether this runtime's `node:zlib` provides zstd support. Checked once; the result never
 * changes within a process, since it depends only on the Node binary this process is running. */
export function isZstdSupported(): boolean {
  return (
    typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
  );
}

/** The message every `zstd`-selecting config validation raises when {@link isZstdSupported} is
 * false, naming the Node version requirement explicitly. */
export function zstdUnsupportedMessage(): string {
  return (
    `zstd compression requires Node.js >= ${ZSTD_MIN_NODE_VERSION} ` +
    `(this runtime's node:zlib does not provide zstdCompressSync/zstdDecompressSync); ` +
    `upgrade Node.js or choose a different compression option`
  );
}

function requireZstdSupport(): void {
  if (!isZstdSupported()) {
    throw new FerruleError('E_ZSTD_UNSUPPORTED', zstdUnsupportedMessage());
  }
}

/** Compresses `input` with zstd. Throws `FerruleError('E_ZSTD_UNSUPPORTED', ...)` if this
 * runtime's `node:zlib` has no zstd support — check {@link isZstdSupported} ahead of time (e.g.
 * at config validation) to fail earlier and with more context than this call site has. */
export function zstdCompress(input: Uint8Array): Buffer {
  requireZstdSupport();
  try {
    return zlib.zstdCompressSync(input);
  } catch (cause) {
    throw new FerruleError('E_ZSTD_COMPRESS', 'zstd compression failed', { cause });
  }
}

export interface ZstdDecompressOptions {
  /** Rejects output above this many bytes, without decompressing the rest. Default 512MiB. */
  readonly maxOutputSize?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/**
 * Decompresses a zstd frame. Bounded by `options.maxOutputSize` (default 512MiB) and never
 * throws anything but a `FerruleError` subclass — `E_ZSTD_UNSUPPORTED` if this runtime has no
 * zstd support, `LimitExceededError` if decompression would exceed the output bound, or
 * `E_ZSTD_CORRUPT` for any other decompression failure (a malformed/truncated frame).
 */
export function zstdDecompress(input: Uint8Array, options: ZstdDecompressOptions = {}): Buffer {
  requireZstdSupport();
  const maxOutputLength = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT_BYTES;
  try {
    return zlib.zstdDecompressSync(input, { maxOutputLength });
  } catch (cause) {
    if (
      cause instanceof RangeError &&
      (cause as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new LimitExceededError('zstd.output', maxOutputLength);
    }
    throw new FerruleError('E_ZSTD_CORRUPT', 'corrupt zstd stream', { cause });
  }
}
