import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { KafkaReader, KafkaWriter } from '../../src/kafka/primitives.js';

describe('KafkaWriter / KafkaReader: fixed-width integers', () => {
  it('round-trips int8/int16/int32/int64', () => {
    const w = new KafkaWriter();
    w.int8(-12).int16(-1234).int32(-123_456_789).int64(-9_007_199_254_740_993n);
    const r = new KafkaReader(w.build());
    expect(r.int8()).toBe(-12);
    expect(r.int16()).toBe(-1234);
    expect(r.int32()).toBe(-123_456_789);
    expect(r.int64()).toBe(-9_007_199_254_740_993n);
  });

  it('round-trips uint32 and boolean', () => {
    const w = new KafkaWriter();
    w.uint32(0xffffffff).boolean(true).boolean(false);
    const r = new KafkaReader(w.build());
    expect(r.uint32()).toBe(0xffffffff);
    expect(r.boolean()).toBe(true);
    expect(r.boolean()).toBe(false);
  });
});

describe('KafkaWriter / KafkaReader: classic (non-flexible) strings, bytes, arrays', () => {
  it('round-trips a string', () => {
    const w = new KafkaWriter().string('hello, kafka');
    const r = new KafkaReader(w.build());
    expect(r.string()).toBe('hello, kafka');
  });

  it('round-trips a null and non-null nullable string', () => {
    const w = new KafkaWriter().nullableString(null).nullableString('present');
    const r = new KafkaReader(w.build());
    expect(r.nullableString()).toBeNull();
    expect(r.nullableString()).toBe('present');
  });

  it('round-trips nullable bytes', () => {
    const w = new KafkaWriter().nullableBytes(null).nullableBytes(Uint8Array.from([1, 2, 3]));
    const r = new KafkaReader(w.build());
    expect(r.nullableBytes()).toBeNull();
    expect(r.nullableBytes()).toEqual(Buffer.from([1, 2, 3]));
  });

  it('round-trips a classic array', () => {
    const w = new KafkaWriter().array([1, 2, 3], (writer, item) => writer.int32(item));
    const r = new KafkaReader(w.build());
    const len = r.arrayLength();
    const items = Array.from({ length: len }, () => r.int32());
    expect(items).toEqual([1, 2, 3]);
  });
});

describe('KafkaWriter / KafkaReader: compact (flexible) strings, bytes, arrays', () => {
  it('round-trips a compact string', () => {
    const w = new KafkaWriter().compactString('flexible');
    const r = new KafkaReader(w.build());
    expect(r.compactString()).toBe('flexible');
  });

  it('round-trips a null and non-null compact nullable string', () => {
    const w = new KafkaWriter().compactNullableString(null).compactNullableString('x');
    const r = new KafkaReader(w.build());
    expect(r.compactNullableString()).toBeNull();
    expect(r.compactNullableString()).toBe('x');
  });

  it('round-trips compact nullable bytes, including an empty (non-null) byte string', () => {
    const w = new KafkaWriter()
      .compactNullableBytes(null)
      .compactNullableBytes(new Uint8Array(0))
      .compactNullableBytes(Uint8Array.from([9, 8, 7]));
    const r = new KafkaReader(w.build());
    expect(r.compactNullableBytes()).toBeNull();
    expect(r.compactNullableBytes()).toEqual(Buffer.alloc(0));
    expect(r.compactNullableBytes()).toEqual(Buffer.from([9, 8, 7]));
  });

  it('round-trips a compact array and the empty tagged-fields terminator', () => {
    const w = new KafkaWriter()
      .compactArray(['a', 'b', 'c'], (writer, item) => writer.compactString(item))
      .emptyTaggedFields();
    const r = new KafkaReader(w.build());
    const len = r.compactArrayLength();
    const items = Array.from({ length: len }, () => r.compactString());
    expect(items).toEqual(['a', 'b', 'c']);
    r.skipTaggedFields();
    expect(r.hasMore).toBe(false);
  });
});

describe('KafkaWriter / KafkaReader: varints', () => {
  it('round-trips zigzag varints across the full int32 range (including negatives)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), (n) => {
        const w = new KafkaWriter().zigzagVarint(n);
        const r = new KafkaReader(w.build());
        expect(r.zigzagVarint()).toBe(n);
      }),
    );
  });

  it('round-trips zigzag varlongs across a wide bigint range', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n }), (n) => {
        const w = new KafkaWriter().zigzagVarlong(n);
        const r = new KafkaReader(w.build());
        expect(r.zigzagVarlong()).toBe(n);
      }),
    );
  });

  it('encodes small values in one byte (compact length prefixes stay cheap)', () => {
    // varint(0) and varint(127) must each be exactly one byte.
    expect(new KafkaWriter().varint(0).build().length).toBe(1);
    expect(new KafkaWriter().varint(127).build().length).toBe(1);
    expect(new KafkaWriter().varint(128).build().length).toBe(2);
  });
});

describe('KafkaWriter / KafkaReader: property round-trip of a realistic mixed struct', () => {
  it('round-trips a Metadata-request-shaped sequence of fields', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
        fc.boolean(),
        fc.boolean(),
        (topics, allowAutoTopicCreation, includeTopicAuthorizedOperations) => {
          const w = new KafkaWriter();
          w.compactArray(topics, (writer, t) => writer.compactString(t).emptyTaggedFields());
          w.boolean(allowAutoTopicCreation);
          w.boolean(includeTopicAuthorizedOperations);
          w.emptyTaggedFields();

          const r = new KafkaReader(w.build());
          const count = r.compactArrayLength();
          const readTopics: string[] = [];
          for (let i = 0; i < count; i++) {
            readTopics.push(r.compactString());
            r.skipTaggedFields();
          }
          expect(readTopics).toEqual(topics);
          expect(r.boolean()).toBe(allowAutoTopicCreation);
          expect(r.boolean()).toBe(includeTopicAuthorizedOperations);
          r.skipTaggedFields();
          expect(r.hasMore).toBe(false);
        },
      ),
    );
  });
});
