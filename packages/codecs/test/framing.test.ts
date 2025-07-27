import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { concatBytes, LimitExceededError, ParseError, utf8Decode, utf8Encode } from '@ferrule/core';
import {
  DelimiterFramer,
  LengthPrefixedFramer,
  NewlineFramer,
  OctetCountingFramer,
  Utf8StreamDecoder,
  VarintLengthFramer,
  type Framer,
} from '@ferrule/codecs';
import { arbChunked } from './arbitraries.js';

function texts(frames: Uint8Array[]): string[] {
  return frames.map((f) => utf8Decode(f, 'strict'));
}

function pushAll(framer: Framer, chunks: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const chunk of chunks) out.push(...framer.push(chunk));
  out.push(...framer.finish());
  return out;
}

describe('NewlineFramer', () => {
  it('splits on \\n', () => {
    const framer = new NewlineFramer();
    const frames = pushAll(framer, [utf8Encode('a\nbb\nccc\n')]);
    expect(texts(frames)).toEqual(['a', 'bb', 'ccc']);
  });

  it('emits a trailing unterminated line on finish', () => {
    const framer = new NewlineFramer();
    const frames = pushAll(framer, [utf8Encode('a\nb')]);
    expect(texts(frames)).toEqual(['a', 'b']);
  });

  it('strips a trailing \\r by default (CRLF support)', () => {
    const framer = new NewlineFramer();
    const frames = pushAll(framer, [utf8Encode('a\r\nb\r\n')]);
    expect(texts(frames)).toEqual(['a', 'b']);
  });

  it('keeps \\r when trimCarriageReturn is false', () => {
    const framer = new NewlineFramer({ trimCarriageReturn: false });
    const frames = pushAll(framer, [utf8Encode('a\r\n')]);
    expect(texts(frames)).toEqual(['a\r']);
  });

  it('is chunk-boundary safe for arbitrary splits', () => {
    const lines = ['first', 'second line', '', 'a bit longer, the fourth line', 'end'];
    const text = `${lines.join('\n')}\n`;
    const bytes = utf8Encode(text);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const frames = pushAll(new NewlineFramer(), chunks);
        expect(texts(frames)).toEqual(lines);
      }),
    );
  });

  it('applies the oversize policy', () => {
    const big = 'x'.repeat(50);
    expect(() =>
      pushAll(new NewlineFramer({ maxLineLength: 10 }), [utf8Encode(`${big}\n`)]),
    ).toThrow(LimitExceededError);

    const truncated = pushAll(new NewlineFramer({ maxLineLength: 10, onOversize: 'truncate' }), [
      utf8Encode(`${big}\nshort\n`),
    ]);
    expect(texts(truncated)).toEqual(['x'.repeat(10), 'short']);

    const skipped = pushAll(new NewlineFramer({ maxLineLength: 10, onOversize: 'skip' }), [
      utf8Encode(`${big}\nshort\n`),
    ]);
    expect(texts(skipped)).toEqual(['short']);
  });

  it('handles oversize detection split across many small pushes', () => {
    const framer = new NewlineFramer({ maxLineLength: 5, onOversize: 'skip' });
    const out: Uint8Array[] = [];
    for (const byte of utf8Encode('abcdefgh\nok\n')) {
      out.push(...framer.push(new Uint8Array([byte])));
    }
    out.push(...framer.finish());
    expect(texts(out)).toEqual(['ok']);
  });
});

describe('DelimiterFramer', () => {
  it('splits on a multi-byte delimiter', () => {
    const framer = new DelimiterFramer('||');
    const frames = pushAll(framer, [utf8Encode('a||bb||ccc')]);
    expect(texts(frames)).toEqual(['a', 'bb', 'ccc']);
  });

  it('handles a delimiter split exactly across a chunk boundary', () => {
    const framer = new DelimiterFramer('||');
    const frames = pushAll(framer, [utf8Encode('a|'), utf8Encode('|b')]);
    expect(texts(frames)).toEqual(['a', 'b']);
  });

  it('rejects an empty delimiter', () => {
    expect(() => new DelimiterFramer('')).toThrow();
  });

  it('is chunk-boundary safe for arbitrary splits with a multi-byte delimiter', () => {
    const parts = ['alpha', 'beta', '', 'gamma', 'd'];
    const text = parts.join('<<>>');
    const bytes = utf8Encode(text);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const frames = pushAll(new DelimiterFramer('<<>>'), chunks);
        expect(texts(frames)).toEqual(parts);
      }),
    );
  });

  it('truncates and resyncs at the next delimiter under the truncate policy', () => {
    const framer = new DelimiterFramer(',', { maxFrameLength: 3, onOversize: 'truncate' });
    const frames = pushAll(framer, [utf8Encode('abcdef,ok,')]);
    expect(texts(frames)).toEqual(['abc', 'ok']);
  });

  it('skips an oversize frame entirely under the skip policy, across chunk boundaries', () => {
    const framer = new DelimiterFramer(',', { maxFrameLength: 3, onOversize: 'skip' });
    const out: Uint8Array[] = [];
    for (const c of [utf8Encode('abcde'), utf8Encode('fgh,ok,')]) out.push(...framer.push(c));
    out.push(...framer.finish());
    expect(texts(out)).toEqual(['ok']);
  });

  it('errors on an unterminated oversize frame that grows across pushes', () => {
    const framer = new DelimiterFramer(',', { maxFrameLength: 3 });
    expect(() => {
      framer.push(utf8Encode('ab'));
      framer.push(utf8Encode('cdef'));
    }).toThrow(LimitExceededError);
  });
});

describe('LengthPrefixedFramer', () => {
  function frame(payload: string, width: 2 | 4, endianness: 'BE' | 'LE'): Uint8Array {
    const body = utf8Encode(payload);
    const header = new Uint8Array(width);
    if (width === 4) {
      if (endianness === 'BE') new DataView(header.buffer).setUint32(0, body.length, false);
      else new DataView(header.buffer).setUint32(0, body.length, true);
    } else {
      if (endianness === 'BE') new DataView(header.buffer).setUint16(0, body.length, false);
      else new DataView(header.buffer).setUint16(0, body.length, true);
    }
    return concatBytes([header, body]);
  }

  it.each([
    ['u16', 'BE'],
    ['u16', 'LE'],
    ['u32', 'BE'],
    ['u32', 'LE'],
  ] as const)('decodes %s %s frames', (width, endianness) => {
    const w = width === 'u16' ? 2 : 4;
    const bytes = concatBytes([frame('hello', w, endianness), frame('world!', w, endianness)]);
    const framer = new LengthPrefixedFramer({ width, endianness });
    expect(texts(pushAll(framer, [bytes]))).toEqual(['hello', 'world!']);
  });

  it('is chunk-boundary safe', () => {
    const bytes = concatBytes([frame('a', 4, 'BE'), frame('bcdef', 4, 'BE'), frame('', 4, 'BE')]);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const frames = pushAll(new LengthPrefixedFramer(), chunks);
        expect(texts(frames)).toEqual(['a', 'bcdef', '']);
      }),
    );
  });

  it('rejects a declared length beyond the limit', () => {
    const framer = new LengthPrefixedFramer({ maxFrameLength: 4 });
    expect(() => framer.push(frame('toolong', 4, 'BE'))).toThrow(LimitExceededError);
  });

  it('throws on a truncated trailing frame at finish', () => {
    const framer = new LengthPrefixedFramer();
    framer.push(frame('hello', 4, 'BE').slice(0, 6));
    expect(() => framer.finish()).toThrow(ParseError);
  });

  it('can include the prefix in the emitted frame', () => {
    const framer = new LengthPrefixedFramer({ includePrefix: true });
    const [f] = framer.push(frame('hi', 4, 'BE'));
    expect(f).toHaveLength(6);
  });
});

describe('VarintLengthFramer', () => {
  function frameOf(payload: string): Uint8Array {
    const body = utf8Encode(payload);
    const bytes: number[] = [];
    let len = body.length;
    do {
      let byte = len & 0x7f;
      len >>>= 7;
      if (len !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (len !== 0);
    return concatBytes([Uint8Array.from(bytes), body]);
  }

  it('decodes varint-length-prefixed frames', () => {
    const bytes = concatBytes([frameOf('x'), frameOf('y'.repeat(200))]);
    const framer = new VarintLengthFramer();
    const frames = pushAll(framer, [bytes]);
    expect(texts(frames)).toEqual(['x', 'y'.repeat(200)]);
  });

  it('is chunk-boundary safe, including across a multi-byte varint', () => {
    const bytes = concatBytes([frameOf('a'.repeat(200)), frameOf('b')]);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const frames = pushAll(new VarintLengthFramer(), chunks);
        expect(texts(frames)).toEqual(['a'.repeat(200), 'b']);
      }),
    );
  });

  it('rejects a declared length beyond the limit', () => {
    const framer = new VarintLengthFramer({ maxFrameLength: 2 });
    expect(() => framer.push(frameOf('toolong'))).toThrow(LimitExceededError);
  });
});

describe('OctetCountingFramer', () => {
  it('decodes octet-counted syslog framing', () => {
    const msg1 = '<34>1 2003-10-11T22:14:15.003Z host app - - - hello';
    const msg2 = '<34>1 2003-10-11T22:14:16.003Z host app - - - world';
    const packet = `${msg1.length} ${msg1}${msg2.length} ${msg2}`;
    const framer = new OctetCountingFramer();
    const frames = pushAll(framer, [utf8Encode(packet)]);
    expect(texts(frames)).toEqual([msg1, msg2]);
  });

  it('falls back to newline framing when the stream does not start with a digit', () => {
    const framer = new OctetCountingFramer();
    const frames = pushAll(framer, [
      utf8Encode('<34>Oct 11 22:14:15 host app: hi\n<34>Oct 11 22:14:16 host app: bye\n'),
    ]);
    expect(texts(frames)).toEqual([
      '<34>Oct 11 22:14:15 host app: hi',
      '<34>Oct 11 22:14:16 host app: bye',
    ]);
  });

  it('is chunk-boundary safe in octet-counting mode', () => {
    const msg1 = 'first message';
    const msg2 = 'second, longer message here';
    const packet = `${msg1.length} ${msg1}${msg2.length} ${msg2}`;
    const bytes = utf8Encode(packet);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const frames = pushAll(new OctetCountingFramer(), chunks);
        expect(texts(frames)).toEqual([msg1, msg2]);
      }),
    );
  });

  it('is chunk-boundary safe in newline-fallback mode', () => {
    const packet = 'no-digit-start\nsecond line\nthird\n';
    const bytes = utf8Encode(packet);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const frames = pushAll(new OctetCountingFramer(), chunks);
        expect(texts(frames)).toEqual(['no-digit-start', 'second line', 'third']);
      }),
    );
  });

  it('rejects an implausibly long length prefix', () => {
    const framer = new OctetCountingFramer({ maxFrameLength: 10 });
    expect(() => framer.push(utf8Encode('123456789012345 '))).toThrow(LimitExceededError);
  });
});

describe('Utf8StreamDecoder', () => {
  it('decodes a multi-byte character split across pushes', () => {
    const text = 'héllo wörld 🎉';
    const bytes = utf8Encode(text);
    fc.assert(
      fc.property(arbChunked(bytes), (chunks) => {
        const decoder = new Utf8StreamDecoder();
        let out = '';
        for (const chunk of chunks) out += decoder.push(chunk);
        out += decoder.finish();
        expect(out).toBe(text);
      }),
    );
  });

  it('replaces malformed sequences in lossy mode', () => {
    const decoder = new Utf8StreamDecoder();
    const out = decoder.push(new Uint8Array([0xff, 0xfe])) + decoder.finish();
    expect(out).toContain('�');
  });

  it('throws in strict mode on malformed input', () => {
    const decoder = new Utf8StreamDecoder({ mode: 'strict' });
    expect(() => decoder.push(new Uint8Array([0xff]))).toThrow(ParseError);
  });
});

describe('reset() restores every framer to its just-constructed state', () => {
  it('NewlineFramer', () => {
    const framer = new NewlineFramer();
    framer.push(utf8Encode('partial line with no terminator'));
    framer.reset();
    expect(texts(pushAll(framer, [utf8Encode('a\nb\n')]))).toEqual(['a', 'b']);
  });

  it('DelimiterFramer', () => {
    const framer = new DelimiterFramer(',');
    framer.push(utf8Encode('unterminated'));
    framer.reset();
    expect(texts(pushAll(framer, [utf8Encode('x,y,')]))).toEqual(['x', 'y']);
  });

  it('LengthPrefixedFramer', () => {
    const framer = new LengthPrefixedFramer();
    framer.push(new Uint8Array([0, 0, 0, 10, 1, 2])); // declares 10 bytes, only 2 supplied
    framer.reset();
    expect(() => framer.finish()).not.toThrow();
  });

  it('VarintLengthFramer', () => {
    const framer = new VarintLengthFramer();
    framer.push(new Uint8Array([0x80, 0x01])); // an incomplete multi-byte varint
    framer.reset();
    expect(() => framer.finish()).not.toThrow();
  });

  it('OctetCountingFramer', () => {
    const framer = new OctetCountingFramer();
    framer.push(utf8Encode('5 abc')); // declares 5 bytes, only 3 supplied
    framer.reset();
    expect(texts(pushAll(framer, [utf8Encode('3 abc')]))).toEqual(['abc']);
  });
});

describe('framers with nothing pushed', () => {
  it('finish() returns an empty array when no bytes were ever pushed', () => {
    expect(new NewlineFramer().finish()).toEqual([]);
    expect(new DelimiterFramer(',').finish()).toEqual([]);
    expect(new LengthPrefixedFramer().finish()).toEqual([]);
    expect(new VarintLengthFramer().finish()).toEqual([]);
    expect(new OctetCountingFramer().finish()).toEqual([]);
  });

  it('push() with an empty chunk returns no frames and does not change state', () => {
    const framer = new NewlineFramer();
    expect(framer.push(new Uint8Array(0))).toEqual([]);
    expect(texts(pushAll(framer, [utf8Encode('still works\n')]))).toEqual(['still works']);
  });
});

describe('LengthPrefixedFramer boundary values', () => {
  it('decodes a u16 length of exactly 65535 (the maximum representable)', () => {
    const payload = new Uint8Array(65535).fill(0x61);
    const header = new Uint8Array(2);
    new DataView(header.buffer).setUint16(0, 65535, false);
    const framer = new LengthPrefixedFramer({ width: 'u16', maxFrameLength: 65535 });
    const [frame] = pushAll(framer, [concatBytes([header, payload])]);
    expect(frame).toHaveLength(65535);
  });

  it('rejects maxFrameLength above the u32 range', () => {
    expect(() => new LengthPrefixedFramer({ maxFrameLength: 2 ** 33 })).toThrow();
  });
});
