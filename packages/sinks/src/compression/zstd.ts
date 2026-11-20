import * as zlib from 'node:zlib';
import { FerruleError, LimitExceededError } from '@ferrule/core';

/**
 * Zstandard compression, delegated to `node:zlib`'s bindings to the libzstd that ships inside
 * Node itself — no third-party or native dependency. The APIs landed in Node v22.15.0/v23.8.0
 * (the workspace-wide `engines` floor is `>=22.15.0` for exactly this reason) and are still
 * marked *Stability: 1 - Experimental*: they have already gained options since release, so every
 * caller in this package goes through this module rather than touching `zlib` directly, leaving
 * one place to absorb any future change in that surface.
 *
 * {@link zstdDecompress} is always bounded. `maxOutputLength` is applied on every call, so a
 * small hostile frame that expands to gigabytes is refused before the allocation rather than
 * after it, and failure arrives as a coded `FerruleError` the way `snappyDecompress`'s (in
 * `../http/snappy.ts`) does — never a raw `zlib` error.
 */

/**
 * libzstd's and the zstd CLI's default level, and Kafka's `compression.zstd.level` default. On
 * our JSON log benchmark (`bench/kafka-compression.ts`) level 1 was both faster and smaller,
 * but 3 stays the default so behaviour matches what Kafka users expect.
 */
export const ZSTD_DEFAULT_LEVEL = 3;

export const ZSTD_MIN_LEVEL = 1;
export const ZSTD_MAX_LEVEL = 22;

/** Matches the ceiling the hand-written Snappy codec in `../http/snappy.ts` applies. */
const DEFAULT_MAX_OUTPUT = 512 * 1024 * 1024;

export interface ZstdCompressOptions {
  /** Compression level, 1–22. Default {@link ZSTD_DEFAULT_LEVEL}. */
  readonly level?: number | undefined;
}

export interface ZstdDecompressOptions {
  /** Refuses a frame that expands beyond this many bytes. Default 512MiB. */
  readonly maxOutputBytes?: number | undefined;
}

/**
 * Whether the running Node build exposes the zstd bindings. Always true on a supported Node
 * (`>=22.15.0`); checked because `engines` is advisory for consumers who install with npm
 * rather than pnpm, and a coded error beats `TypeError: not a function`.
 */
export function zstdAvailable(): boolean {
  return typeof zlib.zstdCompressSync === 'function';
}

function assertAvailable(): void {
  if (zstdAvailable()) return;
  throw new FerruleError(
    'E_ZSTD_UNSUPPORTED',
    `zstd compression requires Node >=22.15.0 (running ${process.version}); ` +
      'upgrade Node or choose another compression codec',
  );
}

function compressOptions(options: ZstdCompressOptions): zlib.ZstdOptions {
  assertAvailable();
  const level = options.level ?? ZSTD_DEFAULT_LEVEL;
  if (!Number.isInteger(level) || level < ZSTD_MIN_LEVEL || level > ZSTD_MAX_LEVEL) {
    throw new FerruleError(
      'E_ZSTD_LEVEL',
      `zstd level must be an integer in ${ZSTD_MIN_LEVEL}..${ZSTD_MAX_LEVEL}, got ${String(level)}`,
    );
  }
  return { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } };
}

/**
 * Compresses `input` into a single zstd frame, synchronously. Cost grows steeply with level: on
 * a 3.8 MiB log body, level 3 took ~50 ms and level 19 ~7 s, all of it blocking the event loop.
 * Prefer {@link zstdCompressAsync} anywhere that is not already committed to a synchronous path.
 */
export function zstdCompress(input: Uint8Array, options: ZstdCompressOptions = {}): Buffer {
  return zlib.zstdCompressSync(input, compressOptions(options));
}

/**
 * {@link zstdCompress} on the libuv threadpool, so a high level or large input does not stall
 * the event loop. Level errors are still thrown synchronously, before any work is queued.
 */
export function zstdCompressAsync(
  input: Uint8Array,
  options: ZstdCompressOptions = {},
): Promise<Buffer> {
  const zstdOptions = compressOptions(options);
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(input, zstdOptions, (error, result) => {
      if (error !== null) {
        reject(new FerruleError('E_ZSTD_COMPRESS', 'zstd compression failed', { cause: error }));
      } else {
        resolve(result);
      }
    });
  });
}

const ZSTD_MAGIC = 0xfd2fb528;
/** Skippable frames (RFC 8878 §3.1.2) use any magic in 0x184D2A50..0x184D2A5F. */
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

/** One zstd frame located inside the input, before any decompression. */
interface FrameSpan {
  readonly start: number;
  readonly end: number;
  /** Frame_Content_Size from the header, when the encoder wrote one. */
  readonly contentSize: number | undefined;
}

function truncated(detail: string): FerruleError {
  return new FerruleError('E_ZSTD_TRUNCATED', `truncated zstd input: ${detail}`);
}

function corrupt(detail: string): FerruleError {
  return new FerruleError('E_ZSTD_CORRUPT', `corrupt zstd input: ${detail}`);
}

/**
 * Splits `input` into frames by walking the format's own length fields (RFC 8878 §3.1): the
 * frame header, then each block's 3-byte header up to the one flagged Last_Block, then the
 * optional 4-byte content checksum. Nothing is decompressed; this costs one pass over a few
 * header bytes per 128KiB block.
 *
 * It exists because `node:zlib` (checked on 22.15.0 and 22.23.5) never verifies that a frame
 * *ended*. Hand `zstdDecompressSync` or `createZstdDecompress` a frame missing its tail and it
 * returns whatever it had decoded so far — often zero bytes, and if only the checksum is cut,
 * all the data with the checksum never checked — and reports success. It also decodes only the
 * first of several concatenated frames and silently discards the rest, where the reference CLI
 * decodes all of them. Walking the framing first makes all three impossible to miss,
 * whether or not the encoder wrote a Frame_Content_Size (streaming encoders, such as the CLI
 * reading a pipe, do not).
 */
function splitFrames(input: Uint8Array): FrameSpan[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length === 0) throw truncated('empty input');
  const frames: FrameSpan[] = [];
  let pos = 0;
  do {
    if (input.length - pos < 4) throw truncated(`${input.length - pos} stray bytes, not a frame`);
    const magic = view.getUint32(pos, true);
    if ((magic & SKIPPABLE_MAGIC_MASK) >>> 0 === SKIPPABLE_MAGIC) {
      if (input.length - pos < 8) throw truncated('skippable frame header');
      const end = pos + 8 + view.getUint32(pos + 4, true);
      if (end > input.length) throw truncated('skippable frame body');
      pos = end;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw corrupt(`unknown frame magic 0x${magic.toString(16)}`);
    const start = pos;
    pos += 4;

    if (pos >= input.length) throw truncated('frame header descriptor');
    const descriptor = input[pos]!;
    pos += 1;
    const fcsFlag = descriptor >>> 6;
    const singleSegment = (descriptor >>> 5) & 1;
    if ((descriptor >>> 3) & 1) throw corrupt('reserved frame header bit set');
    const hasChecksum = (descriptor >>> 2) & 1;
    const dictIdFlag = descriptor & 0b11;
    const fcsBytes =
      fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    // Window_Descriptor is present only when Single_Segment_flag is clear.
    pos += (singleSegment === 1 ? 0 : 1) + (dictIdFlag === 3 ? 4 : dictIdFlag);
    if (pos + fcsBytes > input.length) throw truncated('frame header');
    const contentSize = readContentSize(view, pos, fcsBytes);
    pos += fcsBytes;

    for (;;) {
      if (pos + 3 > input.length) throw truncated('block header');
      const header = input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16);
      pos += 3;
      const blockType = (header >>> 1) & 0b11;
      const blockSize = header >>> 3;
      if (blockType === 3) throw corrupt('reserved block type');
      // RLE blocks store a single byte; Block_Size is then the regenerated length.
      pos += blockType === 1 ? 1 : blockSize;
      if (pos > input.length) throw truncated('block body');
      if ((header & 1) === 1) break;
    }
    if (hasChecksum === 1) {
      pos += 4;
      if (pos > input.length) throw truncated('content checksum');
    }
    frames.push({ start, end: pos, contentSize });
  } while (pos < input.length);
  return frames;
}

function readContentSize(view: DataView, offset: number, bytes: number): number | undefined {
  switch (bytes) {
    case 0:
      return undefined;
    case 1:
      return view.getUint8(offset);
    case 2:
      // The 2-byte form stores the value minus 256.
      return view.getUint16(offset, true) + 256;
    case 4:
      return view.getUint32(offset, true);
    default: {
      const big = view.getBigUint64(offset, true);
      // Anything past 2^53 is far beyond any cap we would accept; saturate so the caller's
      // limit check rejects it instead of silently losing precision.
      return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
    }
  }
}

function decompressFrame(frame: Uint8Array, remaining: number, totalCap: number): Buffer {
  let out: Buffer;
  try {
    // zlib rejects a maxOutputLength of 0 as out of range, which happens when an earlier frame
    // used the whole budget; ask for at least 1 and enforce the real remainder below.
    out = zlib.zstdDecompressSync(frame, { maxOutputLength: Math.max(1, remaining) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new LimitExceededError('zstd.output', totalCap);
    }
    throw new FerruleError('E_ZSTD_CORRUPT', 'corrupt zstd frame', { cause: error });
  }
  if (out.length > remaining) throw new LimitExceededError('zstd.output', totalCap);
  return out;
}

/**
 * Decompresses zstd input — one frame, or several concatenated, with skippable frames ignored —
 * the way the reference CLI does, refusing more than `maxOutputBytes` in total. Raises
 * `LimitExceededError` when the frames declare or produce more than the cap, `E_ZSTD_TRUNCATED`
 * when the input ends mid-frame, and `E_ZSTD_CORRUPT` for any other malformed input (including
 * a bad content checksum); never propagates a raw `zlib` error. See {@link splitFrames} for why
 * the framing is checked here rather than trusted to `zlib`.
 */
export function zstdDecompress(input: Uint8Array, options: ZstdDecompressOptions = {}): Buffer {
  assertAvailable();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const frames = splitFrames(input);

  // Reject on declared sizes before decompressing anything.
  let declaredTotal = 0;
  for (const frame of frames) declaredTotal += frame.contentSize ?? 0;
  if (declaredTotal > maxOutputBytes) throw new LimitExceededError('zstd.output', maxOutputBytes);

  const outputs: Buffer[] = [];
  let produced = 0;
  for (const frame of frames) {
    const out = decompressFrame(
      input.subarray(frame.start, frame.end),
      maxOutputBytes - produced,
      maxOutputBytes,
    );
    // Framing was already proven complete, so this only fires on an encoder that lied about
    // its size; kept because the cost is one comparison.
    if (frame.contentSize !== undefined && out.length !== frame.contentSize) {
      throw corrupt(`frame decoded to ${out.length} bytes but declared ${frame.contentSize}`);
    }
    produced += out.length;
    outputs.push(out);
  }
  return outputs.length === 1 ? outputs[0]! : Buffer.concat(outputs, produced);
}
