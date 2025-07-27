import { LimitExceededError, ValueTypeError } from '@ferrule/core';

const CONTINUATION = 0x80;
const PAYLOAD = 0x7f;

/** Default cap on the number of bytes a varint may occupy (protobuf caps unsigned 64-bit varints at 10). */
export const MAX_VARINT_BYTES = 10;

/**
 * Reads an unsigned LEB128 varint (the encoding protobuf uses for `varint` wire-type fields and
 * that {@link VarintLengthFramer} uses for frame lengths) starting at `offset`.
 *
 * Returns `undefined` if `view` does not yet contain a complete varint at `offset`, so callers
 * streaming a byte source can buffer more data and try again. Throws {@link LimitExceededError}
 * if more than `maxBytes` continuation bytes appear without termination, which bounds how much a
 * hostile input can make the reader scan.
 */
export function tryReadVarint(
  view: Uint8Array,
  offset: number,
  maxBytes: number = MAX_VARINT_BYTES,
): { value: bigint; next: number } | undefined {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < maxBytes; i++) {
    const pos = offset + i;
    if (pos >= view.length) return undefined;
    const byte = view[pos]!;
    result |= BigInt(byte & PAYLOAD) << shift;
    if ((byte & CONTINUATION) === 0) return { value: BigInt.asUintN(64, result), next: pos + 1 };
    shift += 7n;
  }
  throw new LimitExceededError('varint.bytes', maxBytes, `varint longer than ${maxBytes} bytes`);
}

/** Encodes a non-negative integer as an unsigned LEB128 varint. */
export function encodeVarint(value: bigint | number): Uint8Array {
  let v = typeof value === 'number' ? BigInt(value) : value;
  if (v < 0n) {
    throw new ValueTypeError(`cannot encode a negative value (${v}) as an unsigned varint`);
  }
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= CONTINUATION;
    bytes.push(byte);
  } while (v !== 0n);
  return Uint8Array.from(bytes);
}

/** Number of bytes {@link encodeVarint} would produce for `value`, without allocating. */
export function varintByteLength(value: bigint | number): number {
  let v = typeof value === 'number' ? BigInt(value) : value;
  if (v < 0n) throw new ValueTypeError(`cannot size a negative value (${v}) as an unsigned varint`);
  let n = 1;
  v >>= 7n;
  while (v !== 0n) {
    n++;
    v >>= 7n;
  }
  return n;
}

export function zigZagEncode32(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

export function zigZagDecode32(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

export function zigZagEncode64(value: bigint): bigint {
  const v = BigInt.asIntN(64, value);
  return BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
}

export function zigZagDecode64(value: bigint): bigint {
  const v = BigInt.asUintN(64, value);
  return BigInt.asIntN(64, (v >> 1n) ^ -(v & 1n));
}
