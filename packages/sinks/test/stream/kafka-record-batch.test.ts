import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { crc32c } from '@ferrule/buffer';
import { FerruleError, LimitExceededError } from '@ferrule/core';
import { logText } from '../support/log-lines.js';
import {
  decodeRecordBatch,
  encodeRecordBatch,
  type RecordInput,
} from '../../src/kafka/record-batch.js';

function record(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    key: null,
    value: Buffer.from('hello'),
    headers: [],
    timestamp: 1_700_000_000_000n,
    ...overrides,
  };
}

describe('encodeRecordBatch / decodeRecordBatch', () => {
  it('round-trips a single record with a key and value', () => {
    const records = [record({ key: Buffer.from('k1'), value: Buffer.from('v1') })];
    const encoded = encodeRecordBatch(records);
    const decoded = decodeRecordBatch(encoded);
    expect(decoded.crcValid).toBe(true);
    expect(decoded.magic).toBe(2);
    expect(decoded.records).toHaveLength(1);
    expect(decoded.records[0]?.key?.toString('utf8')).toBe('k1');
    expect(decoded.records[0]?.value?.toString('utf8')).toBe('v1');
    expect(decoded.records[0]?.offset).toBe(0n);
  });

  it('round-trips multiple records with correct offsets and timestamps', () => {
    const base = 1_700_000_000_000n;
    const records = [
      record({ value: Buffer.from('a'), timestamp: base }),
      record({ value: Buffer.from('b'), timestamp: base + 10n }),
      record({ value: Buffer.from('c'), timestamp: base + 25n }),
    ];
    const decoded = decodeRecordBatch(encodeRecordBatch(records, { baseOffset: 100n }));
    expect(decoded.records.map((r) => r.offset)).toEqual([100n, 101n, 102n]);
    expect(decoded.records.map((r) => r.timestamp)).toEqual([base, base + 10n, base + 25n]);
    expect(decoded.records.map((r) => r.value?.toString('utf8'))).toEqual(['a', 'b', 'c']);
    expect(decoded.firstTimestamp).toBe(base);
    expect(decoded.maxTimestamp).toBe(base + 25n);
    expect(decoded.lastOffsetDelta).toBe(2);
  });

  it('round-trips record headers', () => {
    const records = [
      record({
        headers: [
          { key: 'trace-id', value: Buffer.from('abc123') },
          { key: 'empty-header', value: null },
        ],
      }),
    ];
    const decoded = decodeRecordBatch(encodeRecordBatch(records));
    expect(decoded.records[0]?.headers).toEqual([
      { key: 'trace-id', value: Buffer.from('abc123') },
      { key: 'empty-header', value: null },
    ]);
  });

  it('round-trips a null key and null value', () => {
    const decoded = decodeRecordBatch(encodeRecordBatch([record({ key: null, value: null })]));
    expect(decoded.records[0]?.key).toBeNull();
    expect(decoded.records[0]?.value).toBeNull();
  });

  it('gzip-compresses and decompresses the records section', () => {
    const payloads = Array.from({ length: 20 }, (_, i) => `payload-${i}`);
    const records = payloads.map((p) => record({ value: Buffer.from(p) }));
    const encoded = encodeRecordBatch(records, { compression: 'gzip' });
    const decoded = decodeRecordBatch(encoded);
    expect(decoded.compression).toBe('gzip');
    expect(decoded.crcValid).toBe(true);
    expect(decoded.records.map((r) => r.value?.toString('utf8'))).toEqual(payloads);
  });

  it('zstd-compresses and decompresses the records section', () => {
    const payloads = Array.from({ length: 20 }, (_, i) => `payload-${i}`);
    const records = payloads.map((p) => record({ value: Buffer.from(p) }));
    const encoded = encodeRecordBatch(records, { compression: 'zstd' });
    const decoded = decodeRecordBatch(encoded);
    expect(decoded.compression).toBe('zstd');
    expect(decoded.crcValid).toBe(true);
    expect(decoded.records.map((r) => r.value?.toString('utf8'))).toEqual(payloads);
  });

  it('honours zstdLevel: a higher level gives a smaller batch that still round-trips', () => {
    const lines = logText(300, 3).toString('utf8').trimEnd().split('\n');
    const records = lines.map((l) => record({ value: Buffer.from(l) }));
    const fast = encodeRecordBatch(records, { compression: 'zstd', zstdLevel: 1 });
    const small = encodeRecordBatch(records, { compression: 'zstd', zstdLevel: 19 });
    expect(small.length).toBeLessThan(fast.length);
    for (const encoded of [fast, small]) {
      expect(decodeRecordBatch(encoded).records.map((r) => r.value?.toString('utf8'))).toEqual(
        lines,
      );
    }
  });

  it('marks zstd with compression code 4 in the batch attributes', () => {
    const encoded = encodeRecordBatch([record()], { compression: 'zstd' });
    // attributes are the first int16 after baseOffset+batchLength+leaderEpoch+magic+crc.
    expect(encoded.readInt16BE(8 + 4 + 4 + 1 + 4) & 0x7).toBe(4);
  });

  it('shrinks a repetitive batch under zstd', () => {
    const records = Array.from({ length: 200 }, () =>
      record({ value: Buffer.from('the same line over and over again') }),
    );
    const plain = encodeRecordBatch(records);
    const compressed = encodeRecordBatch(records, { compression: 'zstd' });
    expect(compressed.length).toBeLessThan(plain.length / 4);
  });

  it('round-trips arbitrary payloads through every supported codec', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ maxLength: 256 }), { minLength: 1, maxLength: 20 }),
        fc.constantFrom('none' as const, 'gzip' as const, 'zstd' as const),
        (values, compression) => {
          const records = values.map((v) => record({ value: Buffer.from(v) }));
          const decoded = decodeRecordBatch(encodeRecordBatch(records, { compression }));
          expect(decoded.compression).toBe(compression);
          expect(decoded.crcValid).toBe(true);
          expect(decoded.records.map((r) => [...(r.value ?? [])])).toEqual(
            values.map((v) => [...v]),
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  for (const compression of ['gzip', 'zstd'] as const) {
    it(`refuses a ${compression} records section that expands past the cap`, () => {
      const big = record({ value: Buffer.alloc(1024 * 1024) });
      const encoded = encodeRecordBatch([big], { compression });
      expect(encoded.length).toBeLessThan(16 * 1024);
      expect(() => decodeRecordBatch(encoded, { maxDecompressedBytes: 4096 })).toThrow(
        LimitExceededError,
      );
      expect(decodeRecordBatch(encoded).records[0]?.value?.length).toBe(1024 * 1024);
    });
  }

  it('reports a truncated gzip records section as a coded error', () => {
    const records = Array.from({ length: 50 }, (_, i) => record({ value: Buffer.from(`v-${i}`) }));
    const encoded = encodeRecordBatch(records, { compression: 'gzip' });
    // Clip the tail of the compressed section; the decoder reads the section as `rest()`.
    let thrown: unknown;
    try {
      decodeRecordBatch(encoded.subarray(0, encoded.length - 6));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FerruleError);
  });

  it('still rejects the codecs that are not implemented', () => {
    for (const compression of ['snappy', 'lz4'] as const) {
      expect(() => encodeRecordBatch([record()], { compression })).toThrow(RangeError);
    }
  });

  it('computes a CRC-32C that matches @ferrule/buffer independently over the same bytes', () => {
    const encoded = encodeRecordBatch([record()]);
    const decoded = decodeRecordBatch(encoded);
    // Reconstruct the exact "after CRC" span from the encoded buffer and check it against a
    // direct crc32c() call, independently of decodeRecordBatch's own crcValid computation path.
    const afterCrc = encoded.subarray(8 + 4 + 4 + 1 + 4); // baseOffset+batchLength+plEpoch+magic+crc
    expect(crc32c(afterCrc)).toBe(decoded.crc);
  });

  it('detects a corrupted batch via crcValid', () => {
    const encoded = encodeRecordBatch([record()]);
    encoded[encoded.length - 1] = (encoded[encoded.length - 1]! + 1) & 0xff;
    const decoded = decodeRecordBatch(encoded);
    expect(decoded.crcValid).toBe(false);
  });

  it('rejects an empty record list', () => {
    expect(() => encodeRecordBatch([])).toThrow(RangeError);
  });

  it('sets isTransactional and marks it in the decoded attributes', () => {
    const decoded = decodeRecordBatch(encodeRecordBatch([record()], { isTransactional: true }));
    expect(decoded.isTransactional).toBe(true);
  });

  it('carries producerId/producerEpoch/baseSequence through', () => {
    const decoded = decodeRecordBatch(
      encodeRecordBatch([record()], { producerId: 555n, producerEpoch: 3, baseSequence: 42 }),
    );
    expect(decoded.producerId).toBe(555n);
    expect(decoded.producerEpoch).toBe(3);
    expect(decoded.baseSequence).toBe(42);
  });

  it('reports totalLength matching the encoded buffer length for a single batch', () => {
    const encoded = encodeRecordBatch([record(), record(), record()]);
    const decoded = decodeRecordBatch(encoded);
    expect(decoded.totalLength).toBe(encoded.length);
  });

  it('property: round-trips an arbitrary batch of records (keys, values, headers, timestamps)', () => {
    const recordArb = fc.record({
      key: fc.option(fc.uint8Array({ maxLength: 30 }), { nil: null }),
      value: fc.option(fc.uint8Array({ maxLength: 30 }), { nil: null }),
      headers: fc.array(
        fc.record({
          key: fc.string({ maxLength: 10 }),
          value: fc.option(fc.uint8Array({ maxLength: 10 }), { nil: null }),
        }),
        { maxLength: 3 },
      ),
      timestampOffset: fc.integer({ min: 0, max: 100_000 }),
    });

    fc.assert(
      fc.property(fc.array(recordArb, { minLength: 1, maxLength: 10 }), (inputs) => {
        const base = 1_600_000_000_000n;
        const records: RecordInput[] = inputs.map((r) => ({
          key: r.key === null ? null : Buffer.from(r.key),
          value: r.value === null ? null : Buffer.from(r.value),
          headers: r.headers.map((h) => ({
            key: h.key,
            value: h.value === null ? null : Buffer.from(h.value),
          })),
          timestamp: base + BigInt(r.timestampOffset),
        }));
        const decoded = decodeRecordBatch(encodeRecordBatch(records));
        expect(decoded.crcValid).toBe(true);
        expect(decoded.records).toHaveLength(records.length);
        for (let i = 0; i < records.length; i++) {
          const expected = records[i]!;
          const actual = decoded.records[i]!;
          expect(actual.key).toEqual(expected.key === null ? null : Buffer.from(expected.key));
          expect(actual.value).toEqual(
            expected.value === null ? null : Buffer.from(expected.value),
          );
          expect(actual.timestamp).toBe(expected.timestamp);
          expect(actual.offset).toBe(BigInt(i));
          expect(actual.headers).toEqual(
            expected.headers.map((h) => ({
              key: h.key,
              value: h.value === null ? null : Buffer.from(h.value),
            })),
          );
        }
      }),
    );
  });
});
