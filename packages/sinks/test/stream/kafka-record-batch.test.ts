import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { crc32c } from '@ferrule/buffer';
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
