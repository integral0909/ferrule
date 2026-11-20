import * as zlib from 'node:zlib';
import { crc32c } from '@ferrule/buffer';
import { FerruleError, LimitExceededError } from '@ferrule/core';
import { zstdCompress, zstdDecompress } from '../compression/zstd.js';
import { KafkaReader, KafkaWriter } from './primitives.js';

/**
 * RecordBatch v2 (magic byte `2`, KIP-98), the wire format Produce requests carry since Kafka
 * 0.11. See "RecordBatch" in the Kafka protocol documentation. Every "varint" field inside a
 * record (as opposed to the fixed-width batch header fields) is zigzag-encoded, matching
 * `KafkaWriter.zigzagVarint`/`zigzagVarlong`.
 */

export type CompressionType = 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';

const COMPRESSION_CODES: Record<CompressionType, number> = {
  none: 0,
  gzip: 1,
  snappy: 2,
  lz4: 3,
  zstd: 4,
};
const COMPRESSION_BY_CODE: CompressionType[] = ['none', 'gzip', 'snappy', 'lz4', 'zstd'];

/**
 * Compresses the records section, synchronously like the rest of batch encoding. zstd needs no
 * broker capability check: KIP-110 gates it at `KAFKA_2_1_IV0`, well below the Produce v9 this
 * producer always speaks, so any broker that accepts our Produce request can read the batch.
 */
function compressRecords(
  raw: Buffer,
  compression: CompressionType,
  zstdLevel: number | undefined,
): Buffer {
  switch (compression) {
    case 'gzip':
      return zlib.gzipSync(raw);
    case 'zstd':
      return zstdCompress(raw, { level: zstdLevel });
    default:
      return raw;
  }
}

function gunzipBounded(section: Buffer, maxBytes: number): Buffer {
  try {
    return zlib.gunzipSync(section, { maxOutputLength: maxBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new LimitExceededError('kafka.records.gzip', maxBytes);
    }
    throw new FerruleError('E_KAFKA_GZIP_CORRUPT', 'corrupt gzip records section', {
      cause: error,
    });
  }
}

/**
 * Ceiling on a decompressed records section. Kafka's own default `message.max.bytes` is ~1MiB
 * and brokers rarely allow more than tens of MiB, so 512MiB (the same cap the zstd wrapper and
 * Snappy codec use) only ever trips on a decompression bomb.
 */
const MAX_DECOMPRESSED_RECORDS = 512 * 1024 * 1024;

/**
 * Inverse of {@link compressRecords}, bounded for every codec. Unlike zstd, `gunzipSync` does
 * report truncation itself (`Z_BUF_ERROR`), so gzip needs only the size cap.
 */
function decompressRecords(
  section: Buffer,
  compression: CompressionType,
  maxBytes: number,
): Buffer {
  switch (compression) {
    case 'gzip':
      return gunzipBounded(section, maxBytes);
    case 'zstd':
      return zstdDecompress(section, { maxOutputBytes: maxBytes });
    default:
      return section;
  }
}

export interface RecordHeaderInput {
  readonly key: string;
  readonly value: Uint8Array | null;
}

export interface RecordInput {
  readonly key: Uint8Array | null;
  readonly value: Uint8Array | null;
  readonly headers: readonly RecordHeaderInput[];
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: bigint;
}

export interface EncodeRecordBatchOptions {
  readonly baseOffset?: bigint;
  /** `none`, `gzip` and `zstd` are supported — all three come from `node:zlib`. `snappy` and
   * `lz4` would need a hand-written codec and are not implemented; requesting them throws. */
  readonly compression?: CompressionType;
  /** zstd level (1–22), used only when `compression` is `zstd`. Default 3. */
  readonly zstdLevel?: number;
  readonly producerId?: bigint;
  readonly producerEpoch?: number;
  readonly baseSequence?: number;
  readonly isTransactional?: boolean;
}

function encodeOneRecord(record: RecordInput, firstTimestamp: bigint, offsetDelta: number): Buffer {
  const body = new KafkaWriter();
  body.int8(0); // record attributes: unused, always 0
  const timestampDelta = record.timestamp - firstTimestamp;
  body.zigzagVarint(Number(timestampDelta));
  body.zigzagVarint(offsetDelta);
  if (record.key === null) body.zigzagVarint(-1);
  else body.zigzagVarint(record.key.length).bytes(record.key);
  if (record.value === null) body.zigzagVarint(-1);
  else body.zigzagVarint(record.value.length).bytes(record.value);
  body.zigzagVarint(record.headers.length);
  for (const header of record.headers) {
    const keyBytes = Buffer.from(header.key, 'utf8');
    body.zigzagVarint(keyBytes.length).bytes(keyBytes);
    if (header.value === null) body.zigzagVarint(-1);
    else body.zigzagVarint(header.value.length).bytes(header.value);
  }
  const bodyBytes = body.build();
  const framed = new KafkaWriter();
  framed.zigzagVarint(bodyBytes.length);
  framed.bytes(bodyBytes);
  return framed.build();
}

/** Encodes `records` (must be non-empty) as one RecordBatch v2. */
export function encodeRecordBatch(
  records: readonly RecordInput[],
  options: EncodeRecordBatchOptions = {},
): Buffer {
  if (records.length === 0) throw new RangeError('a RecordBatch must contain at least one record');
  const compression = options.compression ?? 'none';
  if (compression !== 'none' && compression !== 'gzip' && compression !== 'zstd') {
    throw new RangeError(
      `compression ${compression} is not implemented (only "none", "gzip" and "zstd" are)`,
    );
  }
  const baseOffset = options.baseOffset ?? 0n;
  const firstTimestamp = records[0]!.timestamp;
  let maxTimestamp = firstTimestamp;
  for (const r of records) if (r.timestamp > maxTimestamp) maxTimestamp = r.timestamp;

  const rawRecords = Buffer.concat(records.map((r, i) => encodeOneRecord(r, firstTimestamp, i)));
  const recordsSection = compressRecords(rawRecords, compression, options.zstdLevel);

  let attributes = COMPRESSION_CODES[compression];
  if (options.isTransactional === true) attributes |= 0x10;

  const afterCrc = new KafkaWriter();
  afterCrc.int16(attributes);
  afterCrc.int32(records.length - 1); // lastOffsetDelta
  afterCrc.int64(firstTimestamp);
  afterCrc.int64(maxTimestamp);
  afterCrc.int64(options.producerId ?? -1n);
  afterCrc.int16(options.producerEpoch ?? -1);
  afterCrc.int32(options.baseSequence ?? -1);
  afterCrc.int32(records.length);
  afterCrc.bytes(recordsSection);
  const afterCrcBytes = afterCrc.build();
  const crc = crc32c(afterCrcBytes);

  const batchLength =
    4 /* partitionLeaderEpoch */ + 1 /* magic */ + 4 /* crc */ + afterCrcBytes.length;
  const out = new KafkaWriter();
  out.int64(baseOffset);
  out.int32(batchLength);
  out.int32(-1); // partitionLeaderEpoch: unknown to a producer
  out.int8(2); // magic
  out.uint32(crc);
  out.bytes(afterCrcBytes);
  return out.build();
}

export interface DecodedRecord {
  readonly offset: bigint;
  readonly timestamp: bigint;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: { key: string; value: Buffer | null }[];
}

export interface DecodedRecordBatch {
  readonly baseOffset: bigint;
  readonly batchLength: number;
  readonly partitionLeaderEpoch: number;
  readonly magic: number;
  readonly crc: number;
  readonly crcValid: boolean;
  readonly attributes: number;
  readonly compression: CompressionType;
  readonly isTransactional: boolean;
  readonly lastOffsetDelta: number;
  readonly firstTimestamp: bigint;
  readonly maxTimestamp: bigint;
  readonly producerId: bigint;
  readonly producerEpoch: number;
  readonly baseSequence: number;
  readonly records: DecodedRecord[];
  /** Total bytes this batch occupied in the source buffer (`8 + 4 + batchLength`), so a caller
   * decoding several consecutive batches knows where the next one starts. */
  readonly totalLength: number;
}

export interface DecodeRecordBatchOptions {
  /** Refuses a records section that decompresses past this many bytes. Default 512MiB. */
  readonly maxDecompressedBytes?: number;
}

/** Decodes one RecordBatch v2 starting at the beginning of `buf`. Verifies the CRC-32C but does
 * not throw on a mismatch (reported via `crcValid`) so a caller can decide how to react. */
export function decodeRecordBatch(
  buf: Buffer,
  options: DecodeRecordBatchOptions = {},
): DecodedRecordBatch {
  const header = new KafkaReader(buf);
  const baseOffset = header.int64();
  const batchLength = header.int32();
  const partitionLeaderEpoch = header.int32();
  const magic = header.int8();
  if (magic !== 2) {
    throw new RangeError(`unsupported RecordBatch magic byte ${magic} (only 2 is supported)`);
  }
  const crc = header.uint32();
  const afterCrcLength = batchLength - 4 - 1 - 4;
  const afterCrcBytes = buf.subarray(header.position, header.position + afterCrcLength);
  const crcValid = crc32c(afterCrcBytes) === crc;

  const body = new KafkaReader(Buffer.from(afterCrcBytes));
  const attributes = body.int16();
  const compression = COMPRESSION_BY_CODE[attributes & 0x7] ?? 'none';
  const isTransactional = (attributes & 0x10) !== 0;
  const lastOffsetDelta = body.int32();
  const firstTimestamp = body.int64();
  const maxTimestamp = body.int64();
  const producerId = body.int64();
  const producerEpoch = body.int16();
  const baseSequence = body.int32();
  const recordsCount = body.int32();
  const compressedRecords = body.rest();
  const rawRecords = decompressRecords(
    compressedRecords,
    compression,
    options.maxDecompressedBytes ?? MAX_DECOMPRESSED_RECORDS,
  );

  const recordsReader = new KafkaReader(rawRecords);
  const records: DecodedRecord[] = [];
  for (let i = 0; i < recordsCount; i++) {
    const length = recordsReader.zigzagVarint();
    const startOffset = recordsReader.position;
    recordsReader.int8(); // record attributes, unused
    const timestampDelta = recordsReader.zigzagVarint();
    const offsetDelta = recordsReader.zigzagVarint();
    const keyLength = recordsReader.zigzagVarint();
    const key = keyLength < 0 ? null : recordsReader.bytesRaw(keyLength);
    const valueLength = recordsReader.zigzagVarint();
    const value = valueLength < 0 ? null : recordsReader.bytesRaw(valueLength);
    const headerCount = recordsReader.zigzagVarint();
    const headers: { key: string; value: Buffer | null }[] = [];
    for (let h = 0; h < headerCount; h++) {
      const keyLen = recordsReader.zigzagVarint();
      const headerKey = recordsReader.bytesRaw(keyLen).toString('utf8');
      const valueLen = recordsReader.zigzagVarint();
      const headerValue = valueLen < 0 ? null : recordsReader.bytesRaw(valueLen);
      headers.push({ key: headerKey, value: headerValue });
    }
    const consumed = recordsReader.position - startOffset;
    if (consumed !== length) {
      throw new RangeError(
        `record ${i} declared length ${length} but ${consumed} bytes were consumed`,
      );
    }
    records.push({
      offset: baseOffset + BigInt(offsetDelta),
      timestamp: firstTimestamp + BigInt(timestampDelta),
      key,
      value,
      headers,
    });
  }

  return {
    baseOffset,
    batchLength,
    partitionLeaderEpoch,
    magic,
    crc,
    crcValid,
    attributes,
    compression,
    isTransactional,
    lastOffsetDelta,
    firstTimestamp,
    maxTimestamp,
    producerId,
    producerEpoch,
    baseSequence,
    records,
    totalLength: 8 + 4 + batchLength,
  };
}
