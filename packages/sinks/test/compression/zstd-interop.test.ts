import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crc32c } from '@ferrule/buffer';
import { FerruleError } from '@ferrule/core';
import { zstdCompress, zstdDecompress } from '../../src/compression/zstd.js';
import { decodeRecordBatch, encodeRecordBatch } from '../../src/kafka/record-batch.js';
import { logText } from '../support/log-lines.js';

/**
 * Interop against the *reference* zstd implementation, in both directions:
 *
 * - Fixtures in `./fixtures` were written by the zstd CLI (`generate.sh`; version recorded in
 *   `manifest.json`) and must decode through our wrapper to the exact original bytes. They are
 *   checked in, so this direction always runs.
 * - Our output must decode with the CLI. That needs the CLI at test time: set `ZSTD_CLI` to its
 *   path or put `zstd` on PATH. Without it those tests skip, unless `REQUIRE_ZSTD_CLI=1`, which
 *   turns a missing CLI into a failure so CI cannot pass by silently skipping them.
 *
 * Compressed bytes are never compared, only decoded ones: Node 22.15 bundles libzstd 1.5.6 and
 * later 22.x bundle 1.5.7, and the two need not produce identical frames.
 */

const FIXTURES = new URL('./fixtures/', import.meta.url);

interface Manifest {
  readonly zstdCli: string;
  readonly inputs: Record<'small' | 'large' | 'empty', { bytes: number; sha256: string }>;
}
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURES), 'utf8')) as Manifest;

/** Fixture file -> which manifest input it encodes (two-frames is small followed by large). */
const EXPECTED: Record<string, readonly (keyof Manifest['inputs'])[]> = {
  'small-l3.zst': ['small'],
  'small-l19.zst': ['small'],
  'small-l1-nocheck.zst': ['small'],
  'small-stdin-nosize.zst': ['small'],
  'large-l3.zst': ['large'],
  'large-wlog17.zst': ['large'],
  'empty.zst': ['empty'],
  'two-frames.zst': ['small', 'large'],
};

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURES));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Exact byte equality, reported as length + sha256. `toEqual` on Buffers this size compares
 * element by element (seconds per assertion under suite load) and diffs hugely on failure.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect({ bytes: actual.length, sha256: sha256(actual) }).toEqual({
    bytes: expected.length,
    sha256: sha256(expected),
  });
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FerruleError);
    return (error as FerruleError).code;
  }
  return undefined;
}

describe('zstd interop: reference-CLI fixtures decode through our wrapper', () => {
  it('has a test expectation for every checked-in fixture', () => {
    const onDisk = readdirSync(FIXTURES).filter((f) => f.endsWith('.zst'));
    expect(onDisk.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, parts] of Object.entries(EXPECTED)) {
    it(`decodes ${name} to the original bytes`, () => {
      const out = zstdDecompress(fixture(name));
      const expectedBytes = parts.reduce((n, p) => n + manifest.inputs[p].bytes, 0);
      expect(out.length).toBe(expectedBytes);
      // Check each concatenated part's hash separately so a two-frame mixup is pinpointed.
      let offset = 0;
      for (const part of parts) {
        const { bytes, sha256: hash } = manifest.inputs[part];
        expect(sha256(out.subarray(offset, offset + bytes))).toBe(hash);
        offset += bytes;
      }
    });
  }

  it('decodes the second frame of a concatenated stream, which zlib alone drops', () => {
    const out = zstdDecompress(fixture('two-frames.zst'));
    expect(out.length).toBeGreaterThan(manifest.inputs.small.bytes);
  });

  // Every proper prefix of a frame is truncated input. Exhaustive for the small fixtures (cheap:
  // truncation is caught by the framing walk before anything is decompressed).
  for (const name of ['small-l3.zst', 'small-l1-nocheck.zst', 'small-stdin-nosize.zst']) {
    it(`reports every truncation of ${name} as E_ZSTD_TRUNCATED`, () => {
      const full = fixture(name);
      const wrong: number[] = [];
      for (let len = 0; len < full.length; len++) {
        if (errorCode(() => zstdDecompress(full.subarray(0, len))) !== 'E_ZSTD_TRUNCATED') {
          wrong.push(len);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  it('catches truncation of a frame with no Frame_Content_Size, where zlib returns 0 bytes', () => {
    // The case the earlier content-size comparison could not cover: a streaming encoder (here
    // the CLI reading a pipe) leaves the size out, so there is nothing to compare against.
    const full = fixture('small-stdin-nosize.zst');
    expect(full[4]! >>> 6).toBe(0); // Frame_Content_Size_flag: absent
    expect(errorCode(() => zstdDecompress(full.subarray(0, full.length - 6)))).toBe(
      'E_ZSTD_TRUNCATED',
    );
  });

  it('reports a frame cut inside its content checksum as truncated, not as success', () => {
    // zlib returns the complete data here and never checks the (missing) checksum.
    const full = fixture('small-l3.zst');
    expect(errorCode(() => zstdDecompress(full.subarray(0, full.length - 1)))).toBe(
      'E_ZSTD_TRUNCATED',
    );
  });

  it('reports a wrong content checksum as corrupt', () => {
    const bad = Buffer.from(fixture('small-l3.zst'));
    bad[bad.length - 1]! ^= 0xff;
    expect(errorCode(() => zstdDecompress(bad))).toBe('E_ZSTD_CORRUPT');
  });

  it('reports truncation anywhere in the multi-block and two-frame fixtures', () => {
    const smallFrameEnd = fixture('small-l3.zst').length; // same CLI args as two-frames' first
    for (const name of ['large-l3.zst', 'large-wlog17.zst', 'two-frames.zst']) {
      const full = fixture(name);
      for (let i = 0; i < 300; i++) {
        const len = Math.floor((i / 300) * full.length);
        if (name === 'two-frames.zst' && len === smallFrameEnd) continue; // a complete frame
        expect(errorCode(() => zstdDecompress(full.subarray(0, len)))).toBe('E_ZSTD_TRUNCATED');
      }
    }
  });
});

// --- our output, read by the reference CLI -------------------------------------------------

const ZSTD_CLI = process.env['ZSTD_CLI'] ?? 'zstd';
const cliVersion = spawnSync(ZSTD_CLI, ['-V'], { encoding: 'utf8' });
const cliAvailable = cliVersion.status === 0;
const requireCli = process.env['REQUIRE_ZSTD_CLI'] === '1';

function cliDecompress(frame: Uint8Array): Buffer {
  const result = spawnSync(ZSTD_CLI, ['-d', '-c', '-q'], {
    input: frame,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`zstd -d exited ${String(result.status)}: ${result.stderr.toString()}`);
  }
  return result.stdout;
}

function cliCompressStream(input: Uint8Array): Buffer {
  // Through stdin, like a streaming encoder: no Frame_Content_Size in the header.
  const result = spawnSync(ZSTD_CLI, ['-3', '-c', '-q'], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`zstd exited ${String(result.status)}`);
  return result.stdout;
}

/** RecordBatch v2 header bytes before the records section (see record-batch.ts). */
const BATCH_HEADER_BYTES = 61;
const ATTRIBUTES_OFFSET = 21;
const CRC_OFFSET = 17;

/** Rebuilds `plainBatch` (encoded with `compression: 'none'`) around a foreign records section. */
function withRecordsSection(plainBatch: Buffer, section: Buffer, codec: number): Buffer {
  const out = Buffer.concat([plainBatch.subarray(0, BATCH_HEADER_BYTES), section]);
  out.writeInt16BE((out.readInt16BE(ATTRIBUTES_OFFSET) & ~0x7) | codec, ATTRIBUTES_OFFSET);
  out.writeInt32BE(out.length - 12, 8); // batchLength excludes baseOffset and itself
  out.writeUInt32BE(crc32c(out.subarray(ATTRIBUTES_OFFSET)), CRC_OFFSET);
  return out;
}

function logRecords(count: number) {
  return [...logText(count, 7).toString('utf8').trimEnd().split('\n')].map((line, i) => ({
    key: Buffer.from(`k${i % 8}`),
    value: Buffer.from(line),
    headers: [],
    timestamp: 1_763_553_600_000n + BigInt(i * 13),
  }));
}

describe('zstd interop: reference CLI availability', () => {
  it.runIf(requireCli)('finds the zstd CLI when REQUIRE_ZSTD_CLI=1', () => {
    expect(cliAvailable, `could not run ${ZSTD_CLI} -V`).toBe(true);
  });
});

describe.runIf(cliAvailable)('zstd interop: the reference CLI decodes our output', () => {
  const inputs: [string, Buffer][] = [
    ['empty', Buffer.alloc(0)],
    ['one byte', Buffer.from([0x2a])],
    ['small logs', logText(25, 1)],
    ['large logs (multi-block)', logText(1500, 2)],
    ['incompressible bytes', createHash('sha512').update('seed').digest().subarray(0, 64)],
  ];
  for (const [label, input] of inputs) {
    for (const level of [1, 3, 19]) {
      it(`${label} at level ${level}`, () => {
        expectSameBytes(cliDecompress(zstdCompress(input, { level })), input);
      });
    }
  }

  it('decodes the records section of a zstd Kafka batch we encode', () => {
    const records = logRecords(400);
    const plain = encodeRecordBatch(records);
    const compressed = encodeRecordBatch(records, { compression: 'zstd' });
    expectSameBytes(
      cliDecompress(compressed.subarray(BATCH_HEADER_BYTES)),
      plain.subarray(BATCH_HEADER_BYTES),
    );
  });

  it('lets us decode a Kafka batch whose records were compressed by a streaming encoder', () => {
    // What a JVM producer's zstd-jni stream looks like on the wire: no Frame_Content_Size.
    const records = logRecords(400);
    const plain = encodeRecordBatch(records);
    const section = cliCompressStream(plain.subarray(BATCH_HEADER_BYTES));
    expect(section[4]! >>> 6).toBe(0);
    const decoded = decodeRecordBatch(withRecordsSection(plain, section, 4));
    expect(decoded.crcValid).toBe(true);
    expect(decoded.compression).toBe('zstd');
    expect(decoded.records.map((r) => r.value?.toString('utf8'))).toEqual(
      records.map((r) => r.value.toString('utf8')),
    );
  });

  it('refuses that streamed Kafka batch when its records section is truncated', () => {
    const records = logRecords(400);
    const plain = encodeRecordBatch(records);
    const section = cliCompressStream(plain.subarray(BATCH_HEADER_BYTES));
    const clipped = withRecordsSection(plain, section.subarray(0, section.length - 9), 4);
    // zlib alone hands back a short (often empty) records section for this input and reports
    // success; the error must name the real cause.
    expect(errorCode(() => decodeRecordBatch(clipped))).toBe('E_ZSTD_TRUNCATED');
  });
});
