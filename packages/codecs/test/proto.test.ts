import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LimitExceededError, ParseError } from '@ferrule/core';
import { forEachField, ProtoReader, ProtoWriter, WireType } from '@ferrule/codecs';

describe('varint round trips', () => {
  it('round-trips varints via ProtoWriter/ProtoReader', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (value) => {
        const w = new ProtoWriter();
        w.writeVarintField(1, value);
        const r = new ProtoReader(w.finish());
        const { field, wireType } = r.readTag();
        expect(field).toBe(1);
        expect(wireType).toBe(WireType.Varint);
        expect(r.readVarint()).toBe(value);
      }),
    );
  });

  it('round-trips signed int32/int64', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), (value) => {
        const w = new ProtoWriter();
        w.writeInt32(1, value);
        const r = new ProtoReader(w.finish());
        r.readTag();
        expect(r.readInt32()).toBe(value);
      }),
    );
  });

  it('round-trips zigzag 32/64', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 30), max: 2 ** 30 }), (value) => {
        const w = new ProtoWriter();
        w.writeZigZag32(1, value);
        const r = new ProtoReader(w.finish());
        r.readTag();
        expect(r.readZigZag32()).toBe(value);
      }),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: -(1n << 62n), max: (1n << 62n) - 1n }), (value) => {
        const w = new ProtoWriter();
        w.writeZigZag64(1, value);
        const r = new ProtoReader(w.finish());
        r.readTag();
        expect(r.readZigZag64()).toBe(value);
      }),
    );
  });

  it('round-trips fixed32/fixed64/sfixed32/sfixed64', () => {
    const w = new ProtoWriter();
    w.writeFixed32(1, 0xdeadbeef);
    w.writeFixed64(2, 0x1234567890abcdefn);
    w.writeSFixed32(3, -12345);
    w.writeSFixed64(4, -123456789012345n);
    const r = new ProtoReader(w.finish());
    expect(r.readTag()).toEqual({ field: 1, wireType: WireType.Fixed32 });
    expect(r.readFixed32()).toBe(0xdeadbeef);
    expect(r.readTag()).toEqual({ field: 2, wireType: WireType.Fixed64 });
    expect(r.readFixed64()).toBe(0x1234567890abcdefn);
    expect(r.readTag()).toEqual({ field: 3, wireType: WireType.Fixed32 });
    expect(r.readSFixed32()).toBe(-12345);
    expect(r.readTag()).toEqual({ field: 4, wireType: WireType.Fixed64 });
    expect(r.readSFixed64()).toBe(-123456789012345n);
  });

  it('round-trips float/double', () => {
    const w = new ProtoWriter();
    w.writeFloat(1, 1.5);
    w.writeDouble(2, 1.0e300);
    const r = new ProtoReader(w.finish());
    r.readTag();
    expect(r.readFloat()).toBeCloseTo(1.5, 6);
    r.readTag();
    expect(r.readDouble()).toBe(1.0e300);
  });

  it('round-trips bool', () => {
    const w = new ProtoWriter();
    w.writeBool(1, true);
    w.writeBool(2, false);
    const r = new ProtoReader(w.finish());
    r.readTag();
    expect(r.readBool()).toBe(true);
    r.readTag();
    expect(r.readBool()).toBe(false);
  });

  it('round-trips string and bytes', () => {
    const w = new ProtoWriter();
    w.writeString(1, 'hello, 世界');
    w.writeBytes(2, new Uint8Array([1, 2, 3, 255]));
    const r = new ProtoReader(w.finish());
    r.readTag();
    expect(r.readString()).toBe('hello, 世界');
    r.readTag();
    expect(r.readBytes()).toEqual(new Uint8Array([1, 2, 3, 255]));
  });
});

describe('nested messages', () => {
  it('round-trips a nested message via writeMessage/subReader', () => {
    const w = new ProtoWriter();
    w.writeMessage(1, (child) => {
      child.writeString(1, 'inner');
      child.writeInt32(2, 42);
    });
    const r = new ProtoReader(w.finish());
    r.readTag();
    const sub = r.subReader();
    sub.readTag();
    expect(sub.readString()).toBe('inner');
    sub.readTag();
    expect(sub.readInt32()).toBe(42);
    expect(sub.atEnd()).toBe(true);
  });

  it('enforces maxDepth on nested submessages', () => {
    function build(depth: number): Uint8Array {
      const w = new ProtoWriter();
      if (depth === 0) {
        w.writeInt32(1, 1);
      } else {
        w.writeMessage(1, (child) => child.writeRaw(build(depth - 1)));
      }
      return w.finish();
    }
    const deep = build(10);
    const reader = new ProtoReader(deep, { maxDepth: 3 });
    expect(() => {
      let r = reader;
      for (;;) {
        r.readTag();
        r = r.subReader();
      }
    }).toThrow(LimitExceededError);
  });
});

describe('packed repeated fields', () => {
  it('round-trips a packed repeated varint field', () => {
    const values = [1n, 300n, 70000n, 0n, 5n];
    const w = new ProtoWriter();
    w.writePacked(1, values, (item, v) => item.writeRawVarint(v));
    const r = new ProtoReader(w.finish());
    r.readTag();
    expect(r.readPacked((ir) => ir.readVarint())).toEqual(values);
  });

  it('round-trips a packed repeated fixed64/double field', () => {
    const values = [1.5, -2.25, 0, 1e10];
    const w = new ProtoWriter();
    w.writePacked(1, values, (item, v) => item.writeRawDouble(v));
    const r = new ProtoReader(w.finish());
    r.readTag();
    expect(r.readPacked((ir) => ir.readDouble())).toEqual(values);
  });
});

describe('skipping unknown fields', () => {
  it('skips varint, fixed32, fixed64, and length-delimited fields', () => {
    const w = new ProtoWriter();
    w.writeInt32(1, 5);
    w.writeFixed32(2, 7);
    w.writeFixed64(3, 9n);
    w.writeString(4, 'skip me');
    w.writeInt32(5, 99);
    const bytes = w.finish();
    const kept: number[] = [];
    forEachField(bytes, (field, wireType, r) => {
      if (field === 5) {
        kept.push(r.readInt32());
      } else {
        r.skipValue(wireType);
      }
    });
    expect(kept).toEqual([99]);
  });

  it('skips a deprecated group field, honouring nested groups', () => {
    const w = new ProtoWriter();
    // Manually construct a group: start-group tag, an inner field, a nested group, end-group tag.
    const buf: number[] = [];
    const push = (bytes: Uint8Array): void => {
      for (const b of bytes) buf.push(b);
    };
    const tag = (field: number, wt: number): Uint8Array => {
      const inner = new ProtoWriter();
      inner.writeRawVarint((field << 3) | wt);
      return inner.finish();
    };
    push(tag(10, WireType.StartGroup));
    push(tag(1, WireType.Varint));
    push(new Uint8Array([5]));
    push(tag(2, WireType.StartGroup));
    push(tag(1, WireType.Varint));
    push(new Uint8Array([9]));
    push(tag(2, WireType.EndGroup));
    push(tag(10, WireType.EndGroup));
    w.writeRaw(Uint8Array.from(buf));
    w.writeInt32(20, 123);
    const bytes = w.finish();
    const seen: number[] = [];
    forEachField(bytes, (field, wireType, r) => {
      if (field === 20) seen.push(r.readInt32());
      else r.skipValue(wireType);
    });
    expect(seen).toEqual([123]);
  });
});

describe('bounded, typed errors on malformed input', () => {
  it('never throws anything but a FerruleError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          forEachField(bytes, (_field, wireType, r) => r.skipValue(wireType));
        } catch (error) {
          expect(error).toBeInstanceOf(ParseError);
        }
      }),
    );
  });

  it('throws ParseError on a truncated varint', () => {
    expect(() => new ProtoReader(new Uint8Array([0x80])).readVarint()).toThrow(ParseError);
  });

  it('throws ParseError on a length-delimited field claiming more bytes than remain', () => {
    const w = new ProtoWriter();
    w.writeRawVarint(100);
    expect(() => new ProtoReader(w.finish()).readBytes()).toThrow(ParseError);
  });

  it('throws ParseError on an invalid wire type', () => {
    const w = new ProtoWriter();
    w.writeRawVarint((1 << 3) | 6); // wire type 6 does not exist
    expect(() => new ProtoReader(w.finish()).readTag()).toThrow(ParseError);
  });

  it('requireEnd throws while bytes remain and passes once fully consumed', () => {
    const w = new ProtoWriter();
    w.writeInt32(1, 1);
    const r = new ProtoReader(w.finish());
    expect(() => r.requireEnd()).toThrow(ParseError);
    r.readTag();
    r.readInt32();
    expect(() => r.requireEnd()).not.toThrow();
  });
});

describe('int64 boundary values', () => {
  it('round-trips INT64_MIN and INT64_MAX through int64/zigzag64', () => {
    const min = -(1n << 63n);
    const max = (1n << 63n) - 1n;
    for (const value of [min, max, min + 1n, max - 1n, 0n, -1n]) {
      const w = new ProtoWriter();
      w.writeInt64(1, value);
      w.writeZigZag64(2, value);
      w.writeSFixed64(3, value);
      const r = new ProtoReader(w.finish());
      r.readTag();
      expect(r.readInt64()).toBe(value);
      r.readTag();
      expect(r.readZigZag64()).toBe(value);
      r.readTag();
      expect(r.readSFixed64()).toBe(value);
    }
  });

  it('round-trips INT32 boundary values through int32/zigzag32', () => {
    for (const value of [-(2 ** 31), 2 ** 31 - 1, 0, -1]) {
      const w = new ProtoWriter();
      w.writeInt32(1, value);
      w.writeZigZag32(2, value);
      const r = new ProtoReader(w.finish());
      r.readTag();
      expect(r.readInt32()).toBe(value);
      r.readTag();
      expect(r.readZigZag32()).toBe(value);
    }
  });
});

describe('readPacked with fixed32 items', () => {
  it('round-trips a packed repeated float field', () => {
    const values = [1.5, -2.5, 0, 100.25];
    const w = new ProtoWriter();
    w.writePacked(1, values, (item, v) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, v, true);
      item.writeRaw(b);
    });
    const r = new ProtoReader(w.finish());
    r.readTag();
    const decoded = r.readPacked((ir) => ir.readFloat());
    for (let i = 0; i < values.length; i++) expect(decoded[i]).toBeCloseTo(values[i]!, 4);
  });
});

describe('ProtoWriter.length tracks the encoded byte count', () => {
  it('grows as fields are written', () => {
    const w = new ProtoWriter();
    expect(w.length).toBe(0);
    w.writeInt32(1, 1);
    const afterOne = w.length;
    expect(afterOne).toBeGreaterThan(0);
    w.writeString(2, 'hello');
    expect(w.length).toBeGreaterThan(afterOne);
    expect(w.length).toBe(w.finish().length);
  });
});
