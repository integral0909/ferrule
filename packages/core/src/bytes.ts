import { ParseError } from './errors.js';

const HEX = '0123456789abcdef';

/** Lower-case hexadecimal encoding. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return out;
}

/** Decodes hexadecimal (either case). Throws on odd length or non-hex characters. */
export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new ParseError('E_HEX_SYNTAX', 'hex string must have an even number of digits');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexDigit(text.charCodeAt(i * 2));
    const lo = hexDigit(text.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) throw new ParseError('E_HEX_SYNTAX', 'invalid hex digit', i * 2);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

export function toBase64(bytes: Uint8Array, alphabet: 'standard' | 'url' = 'standard'): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    alphabet === 'url' ? 'base64url' : 'base64',
  );
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_URL = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64 decoding. Node's `Buffer.from(s, 'base64')` silently skips invalid characters;
 * this rejects them, which matters when decoding untrusted payloads.
 */
export function fromBase64(text: string, alphabet: 'standard' | 'url' = 'standard'): Uint8Array {
  const valid =
    alphabet === 'url' ? BASE64_URL.test(text) && text.length % 4 !== 1 : BASE64.test(text);
  if (!valid) throw new ParseError('E_BASE64_SYNTAX', 'invalid base64 input');
  const buf = Buffer.from(text, alphabet === 'url' ? 'base64url' : 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const lossyDecoder = new TextDecoder('utf-8');

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Decodes UTF-8. In `strict` mode malformed input throws; in `lossy` mode (the default) it is
 * replaced with U+FFFD, which is what log pipelines usually want.
 */
export function utf8Decode(bytes: Uint8Array, mode: 'lossy' | 'strict' = 'lossy'): string {
  if (mode === 'lossy') return lossyDecoder.decode(bytes);
  try {
    return strictDecoder.decode(bytes);
  } catch (cause) {
    throw new ParseError('E_UTF8_INVALID', 'invalid UTF-8', undefined, { cause });
  }
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** True if every byte is zero (an all-zero trace or span ID is invalid in OTLP). */
export function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}
