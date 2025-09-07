import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { crc32c } from '@ferrule/buffer';
import {
  decodeSegmentHeader,
  encodeRecord,
  encodeSegmentHeader,
  parseSegmentFileName,
  readRecord,
  RECORD_HEADER_SIZE,
  scanRecord,
  SegmentCorruptError,
  segmentFileName,
  SEGMENT_HEADER_SIZE,
} from '@ferrule/buffer';
import { CodecVersionError } from '@ferrule/buffer';

describe('segment filenames', () => {
  it('formats a 20-digit zero-padded name', () => {
    expect(segmentFileName(0n)).toBe('00000000000000000000.seg');
    expect(segmentFileName(3n)).toBe('00000000000000000003.seg');
    expect(segmentFileName(18446744073709551615n)).toBe('18446744073709551615.seg');
  });

  it('parses a valid name back to its id', () => {
    expect(parseSegmentFileName('00000000000000000042.seg')).toBe(42n);
  });

  it('rejects a negative id', () => {
    expect(() => segmentFileName(-1n)).toThrow(RangeError);
  });

  it('returns undefined for non-segment names', () => {
    expect(parseSegmentFileName('ledger')).toBeUndefined();
    expect(parseSegmentFileName('ledger.tmp')).toBeUndefined();
    expect(parseSegmentFileName('42.seg')).toBeUndefined();
    expect(parseSegmentFileName('00000000000000000042.seg.bak')).toBeUndefined();
    expect(parseSegmentFileName('')).toBeUndefined();
  });

  it('round-trips through fileName/parse for arbitrary ids', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (id) => {
        expect(parseSegmentFileName(segmentFileName(id))).toBe(id);
      }),
    );
  });
});

describe('segment header', () => {
  it('round-trips', () => {
    const header = encodeSegmentHeader();
    expect(header.byteLength).toBe(SEGMENT_HEADER_SIZE);
    expect(() => decodeSegmentHeader(header)).not.toThrow();
  });

  it('rejects a truncated header', () => {
    expect(() => decodeSegmentHeader(encodeSegmentHeader().slice(0, 4))).toThrow(
      SegmentCorruptError,
    );
  });

  it('rejects a bad magic number', () => {
    const header = encodeSegmentHeader();
    header[0] = 0;
    expect(() => decodeSegmentHeader(header)).toThrow(SegmentCorruptError);
  });

  it('rejects an unsupported version', () => {
    const header = encodeSegmentHeader();
    header[4] = 99;
    expect(() => decodeSegmentHeader(header)).toThrow(CodecVersionError);
  });
});

describe('encodeRecord / scanRecord / readRecord', () => {
  it('round-trips a record', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeRecord(7n, payload);
    expect(frame.byteLength).toBe(RECORD_HEADER_SIZE + payload.byteLength);
    const result = scanRecord(frame, 0, 1024);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.seq).toBe(7n);
      expect(result.payload).toEqual(payload);
      expect(result.frameLength).toBe(frame.byteLength);
    }
  });

  it('round-trips arbitrary payloads and sequence numbers (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 500 }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (payload, seq) => {
          const frame = encodeRecord(seq, payload);
          const result = readRecord(frame, 0, payload.byteLength + 1);
          expect(result.seq).toBe(seq);
          expect(result.payload).toEqual(payload);
        },
      ),
    );
  });

  it('reads several concatenated records sequentially', () => {
    const a = encodeRecord(0n, new Uint8Array([1]));
    const b = encodeRecord(1n, new Uint8Array([2, 2]));
    const c = encodeRecord(2n, new Uint8Array([]));
    const buf = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
    buf.set(a, 0);
    buf.set(b, a.byteLength);
    buf.set(c, a.byteLength + b.byteLength);

    let offset = 0;
    const seqs: bigint[] = [];
    while (offset < buf.byteLength) {
      const r = readRecord(buf, offset, 1024);
      seqs.push(r.seq);
      offset += r.frameLength;
    }
    expect(seqs).toEqual([0n, 1n, 2n]);
  });

  it('reports "truncated" when fewer bytes than the frame header remain', () => {
    const frame = encodeRecord(1n, new Uint8Array([1, 2, 3]));
    for (let cut = 0; cut < RECORD_HEADER_SIZE; cut++) {
      const result = scanRecord(frame.slice(0, cut), 0, 1024);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('truncated');
    }
  });

  it('reports "truncated" when the header is present but the payload is cut short', () => {
    const frame = encodeRecord(1n, new Uint8Array(20));
    const cut = frame.slice(0, RECORD_HEADER_SIZE + 5);
    const result = scanRecord(cut, 0, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('truncated');
  });

  it('reports "bad-length" when the declared length exceeds maxPayloadBytes', () => {
    const frame = encodeRecord(1n, new Uint8Array(100));
    const result = scanRecord(frame, 0, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad-length');
      expect(result.frameLength).toBe(RECORD_HEADER_SIZE);
    }
  });

  it('reports "bad-checksum" when the payload is corrupted but the length is intact', () => {
    const frame = encodeRecord(1n, new Uint8Array([9, 9, 9, 9]));
    const corrupted = frame.slice();
    corrupted[RECORD_HEADER_SIZE]! ^= 0xff;
    const result = scanRecord(corrupted, 0, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad-checksum');
      expect(result.frameLength).toBe(frame.byteLength);
    }
  });

  it('reports "bad-checksum" when the stored crc bytes are corrupted', () => {
    const frame = encodeRecord(1n, new Uint8Array([9, 9, 9, 9]));
    const corrupted = frame.slice();
    corrupted[12]! ^= 0xff; // first crc byte
    const result = scanRecord(corrupted, 0, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-checksum');
  });

  it('readRecord throws SegmentCorruptError instead of returning a failure result', () => {
    const frame = encodeRecord(1n, new Uint8Array([1]));
    expect(() => readRecord(frame.slice(0, 2), 0, 1024)).toThrow(SegmentCorruptError);
  });

  it('the checksum actually covers length and seq, not just the payload', () => {
    const frame = encodeRecord(1n, new Uint8Array([1, 2, 3]));
    const corrupted = frame.slice();
    corrupted[4]! ^= 0xff; // flip a byte inside the seq field
    const result = scanRecord(corrupted, 0, 1024);
    expect(result.ok).toBe(false);
  });

  it('crc32c of the frame components matches what scanRecord verifies', () => {
    const payload = new Uint8Array([5, 6, 7]);
    const frame = encodeRecord(3n, payload);
    const lengthAndSeq = frame.subarray(0, 12);
    const expected = crc32c(payload, crc32c(lengthAndSeq));
    const storedCrc = frame[12]! | (frame[13]! << 8) | (frame[14]! << 16) | (frame[15]! << 24);
    expect(storedCrc >>> 0).toBe(expected);
  });

  it('never throws on arbitrary bytes at arbitrary offsets (scanRecord)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.nat(), (bytes, offsetSeed) => {
        const offset = bytes.length === 0 ? 0 : offsetSeed % bytes.length;
        expect(() => scanRecord(bytes, offset, 1024)).not.toThrow();
      }),
    );
  });
});
