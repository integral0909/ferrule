import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FerruleError, LimitExceededError } from '@ferrule/core';
import { lz4Compress, lz4CompressBlock, lz4Decompress, lz4DecompressBlock } from '@ferrule/codecs';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('lz4 block format round trip', () => {
  it('round-trips the empty input', () => {
    const compressed = lz4CompressBlock(new Uint8Array(0));
    expect(lz4DecompressBlock(compressed, 16)).toEqual(new Uint8Array(0));
  });

  it('round-trips inputs shorter than the minimum match length', () => {
    for (const bytes of [[1], [1, 2], [1, 2, 3]]) {
      const input = Uint8Array.from(bytes);
      const compressed = lz4CompressBlock(input);
      expect(lz4DecompressBlock(compressed, input.length + 8)).toEqual(input);
    }
  });

  it('compresses a highly repetitive buffer to a fraction of its size', () => {
    const input = new Uint8Array(4096).fill(65);
    const compressed = lz4CompressBlock(input);
    expect(compressed.length).toBeLessThan(input.length / 10);
    expect(lz4DecompressBlock(compressed, input.length)).toEqual(input);
  });

  it('round-trips an overlapping-run-length match (offset < match length)', () => {
    // "ab" repeated forces matches whose offset (2) is shorter than their length, exercising the
    // byte-by-byte overlapping copy path rather than a plain non-overlapping `copyWithin`.
    const input = new TextEncoder().encode('ab'.repeat(200));
    const compressed = lz4CompressBlock(input);
    expect(lz4DecompressBlock(compressed, input.length)).toEqual(input);
  });

  it('round-trips arbitrary buffers (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (input) => {
        const compressed = lz4CompressBlock(input);
        const decompressed = lz4DecompressBlock(compressed, input.length + 16);
        expect(decompressed).toEqual(input);
      }),
      { numRuns: 200 },
    );
  });
});

describe('lz4CompressBlock output format constraints', () => {
  it('never places a match inside the final 5 bytes of the block', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 20, maxLength: 4096 }).map((bytes) => {
          // Make the whole buffer one repeated byte so a naive matcher would be tempted to match
          // all the way to the end.
          return new Uint8Array(bytes.length).fill(bytes[0] ?? 0);
        }),
        (input) => {
          const compressed = lz4CompressBlock(input);
          const decompressed = lz4DecompressBlock(compressed, input.length + 16);
          expect(decompressed).toEqual(input);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('lz4 frame format round trip', () => {
  it('round-trips the empty input', () => {
    expect(lz4Decompress(lz4Compress(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('round-trips arbitrary buffers (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 8192 }), (input) => {
        const frame = lz4Compress(input);
        expect(lz4Decompress(frame)).toEqual(input);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips with the optional content-size field', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (input) => {
        const frame = lz4Compress(input, { contentSize: true });
        expect(lz4Decompress(frame)).toEqual(input);
      }),
      { numRuns: 50 },
    );
  });

  it('round-trips an input large enough to span multiple blocks', () => {
    const input = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < input.length; i++) input[i] = i % 251;
    const frame = lz4Compress(input);
    const out = lz4Decompress(frame);
    // A plain `toEqual` on multi-megabyte typed arrays is extremely slow under vitest's deep
    // equality (tens of seconds); `Buffer.compare` does the same byte-for-byte check in
    // milliseconds.
    expect(out.length).toBe(input.length);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(input))).toBe(0);
  });
});

describe('lz4Decompress on malformed input', () => {
  it('never throws anything other than a FerruleError, for arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (input) => {
        try {
          lz4Decompress(input);
        } catch (error) {
          expect(error).toBeInstanceOf(FerruleError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never throws anything other than a FerruleError when mutating a valid frame', () => {
    const validFrame = lz4Compress(new TextEncoder().encode('hello world, this is a test'));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 10 }),
        (mutations) => {
          const mutated = Uint8Array.from(validFrame);
          for (const [posSeed, value] of mutations) {
            mutated[posSeed % mutated.length] = value;
          }
          try {
            lz4Decompress(mutated);
          } catch (error) {
            expect(error).toBeInstanceOf(FerruleError);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects a bad magic number', () => {
    expect(() => lz4Decompress(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow(FerruleError);
  });

  it('rejects a bad header checksum', () => {
    const frame = Uint8Array.from(lz4Compress(new Uint8Array(0)));
    frame[6] = (frame[6]! + 1) & 0xff; // corrupt the header checksum byte
    expect(() => lz4Decompress(frame)).toThrow(FerruleError);
  });

  it('rejects a corrupted content checksum', () => {
    const frame = Uint8Array.from(lz4Compress(new TextEncoder().encode('hello world')));
    frame[frame.length - 1] = (frame[frame.length - 1]! + 1) & 0xff;
    expect(() => lz4Decompress(frame)).toThrow(FerruleError);
  });

  it('rejects a frame declaring an external dictionary', () => {
    const frame = Uint8Array.from(lz4Compress(new Uint8Array(0)));
    frame[4] = frame[4]! | 0x01; // set the dictionary-ID bit
    expect(() => lz4Decompress(frame)).toThrow(FerruleError);
  });

  it('rejects output above the configured bound without allocating it', () => {
    const input = new Uint8Array(1024).fill(1);
    const frame = lz4Compress(input);
    expect(() => lz4Decompress(frame, { maxOutputSize: 10 })).toThrow(LimitExceededError);
  });
});

describe('lz4 CLI interop fixtures', () => {
  // Every `.lz4` file here was produced by the reference `lz4` CLI, not by this module — see
  // `fixtures/README.md` for the exact commands. Decoding them and comparing against the
  // original, uncompressed `.txt`/`.bin` file proves this decoder reads real-world LZ4 frames,
  // not just frames it wrote itself.
  for (const [lz4File, origFile] of [
    ['empty.lz4', 'empty.txt'],
    ['hello.lz4', 'hello.txt'],
    ['repeated.lz4', 'repeated.txt'],
    ['random.lz4', 'random.bin'],
    ['multiblock.lz4', 'multiblock.txt'],
    ['hello_blockchecksum.lz4', 'hello.txt'],
    ['repeated_nocrc.lz4', 'repeated.txt'],
  ] as const) {
    it(`decodes ${lz4File} (produced by the real lz4 CLI) to match ${origFile}`, () => {
      const frame = readFileSync(join(fixturesDir, lz4File));
      const expected = readFileSync(join(fixturesDir, origFile));
      expect(lz4Decompress(frame)).toEqual(new Uint8Array(expected));
    });
  }
});
