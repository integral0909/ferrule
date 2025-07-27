import { LimitExceededError, ParseError, ValueTypeError } from '@ferrule/core';
import { AppendBuffer } from './buffer.js';
import type { Framer } from './types.js';
import { tryReadVarint } from '../varint.js';

export type LengthPrefixWidth = 'u16' | 'u32';
export type Endianness = 'BE' | 'LE';

export interface LengthPrefixedFramerOptions {
  /** Width of the length prefix. Default `u32`. */
  width?: LengthPrefixWidth;
  /** Byte order of the length prefix. Default `BE` (network byte order). */
  endianness?: Endianness;
  /** Maximum allowed payload length, prefix excluded. Default 16 MiB. */
  maxFrameLength?: number;
  /** Whether the emitted frame includes the length-prefix bytes. Default `false`. */
  includePrefix?: boolean;
}

const DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * Splits a byte stream framed as `<length prefix><payload>` repeated, where the prefix is a
 * fixed-width big- or little-endian unsigned integer giving the payload length in bytes. Common
 * for TCP-framed binary protocols (Kafka-style, custom RPC).
 */
export class LengthPrefixedFramer implements Framer {
  private readonly prefixLength: number;
  private readonly endianness: Endianness;
  private readonly maxFrameLength: number;
  private readonly includePrefix: boolean;
  private buf = new AppendBuffer();

  constructor(options: LengthPrefixedFramerOptions = {}) {
    const width = options.width ?? 'u32';
    this.prefixLength = width === 'u16' ? 2 : 4;
    this.endianness = options.endianness ?? 'BE';
    this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    if (this.maxFrameLength > 0xffffffff) {
      throw new ValueTypeError('maxFrameLength must fit in an unsigned 32-bit integer');
    }
    this.includePrefix = options.includePrefix ?? false;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    if (chunk.length > 0) this.buf.append(chunk);
    for (;;) {
      if (this.buf.length < this.prefixLength) break;
      const view = this.buf.view();
      const len = this.readLength(view);
      if (len > this.maxFrameLength) {
        throw new LimitExceededError(
          'frame.length',
          this.maxFrameLength,
          `length-prefixed frame declares ${len} byte(s), exceeding the ${this.maxFrameLength}-byte limit`,
        );
      }
      const total = this.prefixLength + len;
      if (view.length < total) break;
      frames.push(this.includePrefix ? view.slice(0, total) : view.slice(this.prefixLength, total));
      this.buf.consume(total);
    }
    return frames;
  }

  finish(): Uint8Array[] {
    if (this.buf.length > 0) {
      const remaining = this.buf.length;
      this.reset();
      throw new ParseError(
        'E_FRAME_TRUNCATED',
        `stream ended with ${remaining} trailing byte(s) of an incomplete length-prefixed frame`,
      );
    }
    return [];
  }

  reset(): void {
    this.buf.clear();
  }

  private readLength(view: Uint8Array): number {
    const [b0, b1, b2, b3] = [view[0]!, view[1]!, view[2]!, view[3]!];
    if (this.prefixLength === 2) {
      return this.endianness === 'BE' ? (b0 << 8) | b1 : (b1 << 8) | b0;
    }
    return this.endianness === 'BE'
      ? ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0
      : ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
  }
}

export interface VarintLengthFramerOptions {
  /** Maximum allowed payload length, prefix excluded. Default 16 MiB. */
  maxFrameLength?: number;
  /** Whether the emitted frame includes the length-prefix bytes. Default `false`. */
  includePrefix?: boolean;
}

/**
 * Splits a byte stream framed as `<unsigned LEB128 varint length><payload>` repeated, matching
 * the length delimiter protobuf tooling uses for `writeDelimitedTo`-style streaming.
 */
export class VarintLengthFramer implements Framer {
  private readonly maxFrameLength: number;
  private readonly includePrefix: boolean;
  private buf = new AppendBuffer();

  constructor(options: VarintLengthFramerOptions = {}) {
    this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    this.includePrefix = options.includePrefix ?? false;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    if (chunk.length > 0) this.buf.append(chunk);
    for (;;) {
      const view = this.buf.view();
      const header = tryReadVarint(view, 0);
      if (header === undefined) break;
      if (header.value > BigInt(this.maxFrameLength)) {
        throw new LimitExceededError(
          'frame.length',
          this.maxFrameLength,
          `varint-length-prefixed frame declares ${header.value} byte(s), exceeding the ${this.maxFrameLength}-byte limit`,
        );
      }
      const len = Number(header.value);
      const total = header.next + len;
      if (view.length < total) break;
      frames.push(this.includePrefix ? view.slice(0, total) : view.slice(header.next, total));
      this.buf.consume(total);
    }
    return frames;
  }

  finish(): Uint8Array[] {
    if (this.buf.length > 0) {
      const remaining = this.buf.length;
      this.reset();
      throw new ParseError(
        'E_FRAME_TRUNCATED',
        `stream ended with ${remaining} trailing byte(s) of an incomplete varint-length-prefixed frame`,
      );
    }
    return [];
  }

  reset(): void {
    this.buf.clear();
  }
}
