import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FramingError } from '@ferrule/lsp';

describe('encodeFrame / FrameDecoder', () => {
  it('round-trips a single message delivered whole', () => {
    const decoder = new FrameDecoder();
    const message = { jsonrpc: '2.0', id: 1, method: 'foo' };
    expect(decoder.push(encodeFrame(message))).toEqual([message]);
    expect(decoder.hasPendingData).toBe(false);
  });

  it('decodes several messages that arrive in a single chunk', () => {
    const decoder = new FrameDecoder();
    const a = { jsonrpc: '2.0', method: 'a' };
    const b = { jsonrpc: '2.0', method: 'b' };
    const c = { jsonrpc: '2.0', id: 9, method: 'c' };
    const combined = Buffer.concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);
    expect(decoder.push(combined)).toEqual([a, b, c]);
  });

  it('decodes a message fed one byte at a time', () => {
    const decoder = new FrameDecoder();
    const message = { jsonrpc: '2.0', method: 'foo', params: { text: 'hello world' } };
    const frame = encodeFrame(message);
    const decoded: unknown[] = [];
    for (let i = 0; i < frame.length; i++) {
      decoded.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(decoded).toEqual([message]);
  });

  it('handles the header being split mid-line', () => {
    const decoder = new FrameDecoder();
    const message = { jsonrpc: '2.0', method: 'x' };
    const frame = encodeFrame(message);
    const splitAt = 'Content-Length: '.length + 1; // inside the digits
    expect(decoder.push(frame.subarray(0, splitAt))).toEqual([]);
    expect(decoder.hasPendingData).toBe(true);
    expect(decoder.push(frame.subarray(splitAt))).toEqual([message]);
  });

  it('handles the body being split mid-multi-byte-character', () => {
    const decoder = new FrameDecoder();
    const message = { jsonrpc: '2.0', method: 'm', params: { text: 'emoji: 🎉 café' } };
    const frame = encodeFrame(message);
    // Split right in the middle of the 4-byte UTF-8 encoding of the emoji.
    const emojiByteStart = frame.indexOf(Buffer.from('🎉', 'utf8'));
    const splitAt = emojiByteStart + 2;
    const first = decoder.push(frame.subarray(0, splitAt));
    expect(first).toEqual([]);
    expect(decoder.push(frame.subarray(splitAt))).toEqual([message]);
  });

  it('decodes back-to-back messages split at an arbitrary boundary inside the second header', () => {
    const decoder = new FrameDecoder();
    const a = { jsonrpc: '2.0', method: 'first' };
    const b = { jsonrpc: '2.0', method: 'second' };
    const frameA = encodeFrame(a);
    const frameB = encodeFrame(b);
    const splitInsideB = 5;
    const first = decoder.push(Buffer.concat([frameA, frameB.subarray(0, splitInsideB)]));
    expect(first).toEqual([a]);
    expect(decoder.push(frameB.subarray(splitInsideB))).toEqual([b]);
  });

  it('throws FramingError when Content-Length is missing', () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push('X-Custom: 1\r\n\r\n{}')).toThrow(FramingError);
  });

  it('throws FramingError for a body that is not valid JSON', () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from('not json', 'utf8');
    const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
    expect(() => decoder.push(Buffer.concat([Buffer.from(header, 'ascii'), body]))).toThrow(
      FramingError,
    );
  });

  it('property: any chunking of a message stream reproduces the same messages in order', () => {
    const messageArb = fc.record({
      jsonrpc: fc.constant('2.0' as const),
      method: fc.constantFrom('textDocument/didOpen', 'hover', '$/cancelRequest', 'a', 'foo/bar'),
      params: fc.dictionary(
        fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 6 }),
        fc.oneof(fc.string({ unit: 'grapheme-ascii', maxLength: 10 }), fc.integer(), fc.boolean()),
      ),
    });

    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 37 }), { minLength: 1, maxLength: 20 }),
        (messages, chunkSizes) => {
          const full = Buffer.concat(messages.map((m) => encodeFrame(m)));
          const decoder = new FrameDecoder();
          const decoded: unknown[] = [];
          let offset = 0;
          let chunkIndex = 0;
          while (offset < full.length) {
            const size = chunkSizes[chunkIndex % chunkSizes.length]!;
            chunkIndex++;
            const end = Math.min(offset + size, full.length);
            decoded.push(...decoder.push(full.subarray(offset, end)));
            offset = end;
          }
          expect(decoded).toEqual(messages);
          expect(decoder.hasPendingData).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
