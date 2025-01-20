import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  concatBytes,
  fromBase64,
  fromHex,
  isAllZero,
  ParseError,
  toBase64,
  toHex,
  utf8Decode,
  utf8Encode,
} from '@ferrule/core';

describe('hex', () => {
  it('encodes and decodes', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
    expect(fromHex('000FfF')).toEqual(new Uint8Array([0, 15, 255]));
  });

  it('rejects malformed input', () => {
    expect(() => fromHex('abc')).toThrow(ParseError);
    expect(() => fromHex('zz')).toThrow(ParseError);
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(fc.uint8Array(), (b) => {
        expect(fromHex(toHex(b))).toEqual(b);
      }),
    );
  });
});

describe('base64', () => {
  it('encodes both alphabets', () => {
    const bytes = new Uint8Array([0xfb, 0xff]);
    expect(toBase64(bytes)).toBe('+/8=');
    expect(toBase64(bytes, 'url')).toBe('-_8');
  });

  it('decodes strictly', () => {
    expect(fromBase64('aGk=')).toEqual(new Uint8Array([104, 105]));
    expect(fromBase64('-_8', 'url')).toEqual(new Uint8Array([0xfb, 0xff]));
    for (const bad of ['aGk', 'a*k=', 'aGk==', '=aGk']) {
      expect(() => fromBase64(bad)).toThrow(ParseError);
    }
    expect(() => fromBase64('a', 'url')).toThrow(ParseError);
    expect(() => fromBase64('a+b', 'url')).toThrow(ParseError);
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(fc.uint8Array(), (b) => {
        expect(fromBase64(toBase64(b))).toEqual(b);
        expect(fromBase64(toBase64(b, 'url'), 'url')).toEqual(b);
      }),
    );
  });
});

describe('utf8', () => {
  it('round-trips text', () => {
    expect(utf8Decode(utf8Encode('héllo 😀'))).toBe('héllo 😀');
  });

  it('replaces or rejects malformed input', () => {
    const bad = new Uint8Array([0x61, 0xff, 0x62]);
    expect(utf8Decode(bad)).toBe('a�b');
    expect(() => utf8Decode(bad, 'strict')).toThrow(ParseError);
  });
});

describe('byte helpers', () => {
  it('concatenates and detects all-zero buffers', () => {
    expect(concatBytes([new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3])])).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(isAllZero(new Uint8Array(8))).toBe(true);
    expect(isAllZero(new Uint8Array([0, 1]))).toBe(false);
  });
});
