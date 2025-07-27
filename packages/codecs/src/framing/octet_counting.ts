import { LimitExceededError, ParseError } from '@ferrule/core';
import { AppendBuffer } from './buffer.js';
import { NewlineFramer, type NewlineFramerOptions } from './newline.js';
import type { Framer } from './types.js';

export interface OctetCountingFramerOptions {
  /** Maximum message length in bytes. Default 1 MiB. */
  maxFrameLength?: number;
  /** Options for the newline-delimited fallback framer (see class doc). */
  fallback?: NewlineFramerOptions;
}

/**
 * Frames syslog transport per RFC 6587 §3.4: `OCTET-COUNT SP MSG` repeated, where `OCTET-COUNT`
 * is a decimal ASCII byte count with no length limit of its own syntax, and `MSG` is exactly that
 * many bytes (no terminator needed, since the length is explicit).
 *
 * Many syslog senders instead use "non-transparent framing" (one message per line, RFC 6587
 * §3.4.2) despite claiming octet-counting, or simply were never told to use octet-counting at
 * all. Per the RFC's guidance, this framer detects which is in use from the first byte of the
 * stream: if it is an ASCII digit, the stream is treated as octet-counted; otherwise every
 * message in the connection is read as newline-delimited instead. The decision is made once, from
 * the first byte, and holds for the lifetime of the framer.
 */
export class OctetCountingFramer implements Framer {
  private readonly maxFrameLength: number;
  private readonly fallbackOptions: NewlineFramerOptions | undefined;
  private mode: 'detecting' | 'octet-counting' | 'newline' = 'detecting';
  private buf = new AppendBuffer();
  private newlineFramer: NewlineFramer;

  constructor(options: OctetCountingFramerOptions = {}) {
    this.maxFrameLength = options.maxFrameLength ?? 1024 * 1024;
    this.fallbackOptions = options.fallback;
    this.newlineFramer = this.makeNewlineFramer();
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length === 0) return [];
    if (this.mode === 'detecting') {
      this.buf.append(chunk);
      if (this.buf.length === 0) return [];
      const first = this.buf.view()[0]!;
      if (first >= 0x30 && first <= 0x39) {
        this.mode = 'octet-counting';
        return this.drainOctetCounting();
      }
      this.mode = 'newline';
      const buffered = this.buf.view().slice();
      this.buf.clear();
      return this.newlineFramer.push(buffered);
    }
    if (this.mode === 'newline') return this.newlineFramer.push(chunk);
    this.buf.append(chunk);
    return this.drainOctetCounting();
  }

  finish(): Uint8Array[] {
    if (this.mode === 'newline') return this.newlineFramer.finish();
    if (this.buf.length > 0) {
      const remaining = this.buf.length;
      this.reset();
      throw new ParseError(
        'E_FRAME_TRUNCATED',
        `stream ended with ${remaining} trailing byte(s) of an incomplete octet-counted frame`,
      );
    }
    return [];
  }

  reset(): void {
    this.mode = 'detecting';
    this.buf.clear();
    this.newlineFramer = this.makeNewlineFramer();
  }

  private makeNewlineFramer(): NewlineFramer {
    return new NewlineFramer({ maxLineLength: this.maxFrameLength, ...this.fallbackOptions });
  }

  private drainOctetCounting(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    const maxDigits = String(this.maxFrameLength).length + 1;
    for (;;) {
      const view = this.buf.view();
      let i = 0;
      while (i < view.length && view[i]! >= 0x30 && view[i]! <= 0x39) i++;
      if (i === 0) {
        if (view.length === 0) break;
        throw new ParseError('E_SYSLOG_FRAME_SYNTAX', 'expected an octet-counting message length');
      }
      if (i === view.length) {
        if (i > maxDigits) {
          throw new LimitExceededError(
            'frame.length',
            this.maxFrameLength,
            'octet-counting length prefix is implausibly long',
          );
        }
        break; // more digits may still be coming
      }
      if (view[i] !== 0x20) {
        throw new ParseError(
          'E_SYSLOG_FRAME_SYNTAX',
          'expected a space after the octet-counting message length',
          i,
        );
      }
      let len = 0;
      for (let k = 0; k < i; k++) len = len * 10 + (view[k]! - 0x30);
      if (len > this.maxFrameLength) {
        throw new LimitExceededError(
          'frame.length',
          this.maxFrameLength,
          `octet-counting length ${len} exceeds the ${this.maxFrameLength}-byte limit`,
        );
      }
      const headerLength = i + 1;
      const total = headerLength + len;
      if (view.length < total) break;
      frames.push(view.slice(headerLength, total));
      this.buf.consume(total);
    }
    return frames;
  }
}
