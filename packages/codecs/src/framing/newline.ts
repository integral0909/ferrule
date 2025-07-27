import { DelimiterFramer } from './delimiter.js';
import type { Framer, OversizePolicy } from './types.js';

export interface NewlineFramerOptions {
  /** Maximum line length in bytes, terminator excluded. Default 1 MiB. */
  maxLineLength?: number;
  /** What happens when a line would exceed `maxLineLength`. Default `error`. */
  onOversize?: OversizePolicy;
  /** Whether a trailing `\r` right before the `\n` is stripped from each line. Default `true`,
   * so both Unix (`\n`) and Windows (`\r\n`) line endings produce the same frames. */
  trimCarriageReturn?: boolean;
}

/** Splits a byte stream on `\n`, the most common framing for logs (NDJSON, plain text files, ...). */
export class NewlineFramer implements Framer {
  private readonly inner: DelimiterFramer;
  private readonly trimCarriageReturn: boolean;

  constructor(options: NewlineFramerOptions = {}) {
    this.inner = new DelimiterFramer(new Uint8Array([0x0a]), {
      maxFrameLength: options.maxLineLength ?? 1024 * 1024,
      onOversize: options.onOversize ?? 'error',
    });
    this.trimCarriageReturn = options.trimCarriageReturn ?? true;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    return this.postprocess(this.inner.push(chunk));
  }

  finish(): Uint8Array[] {
    return this.postprocess(this.inner.finish());
  }

  reset(): void {
    this.inner.reset();
  }

  private postprocess(frames: Uint8Array[]): Uint8Array[] {
    if (!this.trimCarriageReturn) return frames;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      if (f.length > 0 && f[f.length - 1] === 0x0d) frames[i] = f.subarray(0, f.length - 1);
    }
    return frames;
  }
}
