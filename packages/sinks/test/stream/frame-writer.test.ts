import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LimitExceededError, utf8Decode, utf8Encode } from '@ferrule/core';
import { frameBytes } from '../../src/stream/frame-writer.js';

describe('frameBytes', () => {
  it('newline: appends a single 0x0a', () => {
    const framed = frameBytes({ kind: 'newline' }, utf8Encode('abc'));
    expect(utf8Decode(framed)).toBe('abc\n');
  });

  it('octet_counting: prefixes "<len> "', () => {
    const framed = frameBytes({ kind: 'octet_counting' }, utf8Encode('hello'));
    expect(utf8Decode(framed)).toBe('5 hello');
  });

  it('length_prefixed u32 BE: writes a 4-byte big-endian length prefix', () => {
    const payload = utf8Encode('hello world');
    const framed = frameBytes({ kind: 'length_prefixed', width: 'u32', endianness: 'BE' }, payload);
    const view = Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength);
    expect(view.readUInt32BE(0)).toBe(payload.length);
    expect(view.subarray(4).toString('utf8')).toBe('hello world');
  });

  it('length_prefixed u16 LE: writes a 2-byte little-endian length prefix', () => {
    const payload = utf8Encode('x');
    const framed = frameBytes({ kind: 'length_prefixed', width: 'u16', endianness: 'LE' }, payload);
    const view = Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength);
    expect(view.readUInt16LE(0)).toBe(1);
  });

  it('length_prefixed rejects a payload that does not fit the declared width', () => {
    const oversized = new Uint8Array(70_000);
    expect(() =>
      frameBytes({ kind: 'length_prefixed', width: 'u16', endianness: 'BE' }, oversized),
    ).toThrow(LimitExceededError);
  });

  it('property: octet-counted frame length prefix always matches the payload length', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 500 }), (payload) => {
        const framed = frameBytes({ kind: 'octet_counting' }, payload);
        const text = utf8Decode(framed, 'lossy');
        const spaceIdx = text.indexOf(' ');
        const declared = Number(text.slice(0, spaceIdx));
        expect(declared).toBe(payload.length);
      }),
    );
  });
});
