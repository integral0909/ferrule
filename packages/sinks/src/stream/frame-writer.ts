import { concatBytes, LimitExceededError, utf8Encode } from '@ferrule/core';

/**
 * How one encoded event is framed on the wire before being written to a stream socket. Mirrors
 * the decoding-side framers in `@ferrule/codecs` (newline, length-prefixed, octet-counting), but
 * for the write direction: given one already-encoded payload, produce the bytes to write.
 */
export type FramingMode =
  | { readonly kind: 'newline' }
  | {
      readonly kind: 'length_prefixed';
      readonly width: 'u16' | 'u32';
      readonly endianness: 'BE' | 'LE';
    }
  | { readonly kind: 'octet_counting' };

const NEWLINE = new Uint8Array([0x0a]);

/** Frames `payload` per `mode`. Throws {@link LimitExceededError} if a length-prefixed payload
 * does not fit in its declared width. */
export function frameBytes(mode: FramingMode, payload: Uint8Array): Uint8Array {
  switch (mode.kind) {
    case 'newline':
      return concatBytes([payload, NEWLINE]);
    case 'length_prefixed': {
      const width = mode.width === 'u16' ? 2 : 4;
      const max = width === 2 ? 0xffff : 0xffffffff;
      if (payload.length > max) {
        throw new LimitExceededError(
          'frame.length',
          max,
          `payload of ${payload.length} byte(s) does not fit in a ${mode.width} length prefix`,
        );
      }
      const header = new Uint8Array(width);
      const view = new DataView(header.buffer);
      const be = mode.endianness === 'BE';
      if (width === 2) view.setUint16(0, payload.length, !be);
      else view.setUint32(0, payload.length, !be);
      return concatBytes([header, payload]);
    }
    case 'octet_counting':
      return concatBytes([utf8Encode(`${payload.length} `), payload]);
  }
}
