import { ParseError } from '@ferrule/core';

export interface Utf8StreamDecoderOptions {
  /** `lossy` (default) replaces malformed sequences with U+FFFD; `strict` throws {@link ParseError}. */
  mode?: 'lossy' | 'strict';
}

/**
 * The "character set" layer: decodes UTF-8 bytes to text incrementally, correctly handling
 * multi-byte sequences split across chunk boundaries (which byte-oriented framers do not need to
 * worry about, since ASCII delimiters like `\n` never appear as a continuation byte of a
 * multi-byte sequence, but a decoder built on top of a byte stream directly does).
 */
export class Utf8StreamDecoder {
  private readonly decoder: InstanceType<typeof TextDecoder>;
  private readonly strict: boolean;

  constructor(options: Utf8StreamDecoderOptions = {}) {
    this.strict = (options.mode ?? 'lossy') === 'strict';
    this.decoder = new TextDecoder('utf-8', { fatal: this.strict });
  }

  /** Decodes as much of `chunk` as forms complete characters, buffering any trailing partial
   * sequence for the next call. */
  push(chunk: Uint8Array): string {
    try {
      return this.decoder.decode(chunk, { stream: true });
    } catch (cause) {
      throw new ParseError('E_UTF8_INVALID', 'invalid UTF-8 in streamed input', undefined, {
        cause,
      });
    }
  }

  /** Flushes any buffered trailing bytes. In `strict` mode, a dangling incomplete sequence throws. */
  finish(): string {
    try {
      return this.decoder.decode();
    } catch (cause) {
      throw new ParseError('E_UTF8_INVALID', 'invalid UTF-8 at end of streamed input', undefined, {
        cause,
      });
    }
  }

  /** Discards any buffered partial sequence. */
  reset(): void {
    try {
      this.decoder.decode();
    } catch {
      // Discarding state intentionally; a dangling sequence at reset time is not an error.
    }
  }
}
