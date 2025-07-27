import { concatBytes, LimitExceededError, utf8Encode, ValueTypeError } from '@ferrule/core';
import { AppendBuffer } from './buffer.js';
import type { Framer, OversizePolicy } from './types.js';

export interface DelimiterFramerOptions {
  /** Maximum frame length in bytes, delimiter excluded. Default 1 MiB. */
  maxFrameLength?: number;
  /** What happens when a frame would exceed `maxFrameLength`. Default `error`. */
  onOversize?: OversizePolicy;
}

const DEFAULT_MAX_FRAME_LENGTH = 1024 * 1024;

/**
 * Splits a byte stream on an arbitrary, fixed, non-empty byte delimiter (which may be more than
 * one byte, e.g. `"\r\n"` or a custom record separator). {@link NewlineFramer} is built on top of
 * this for the common single-byte `"\n"` case.
 *
 * Bounded: buffered, undelimited data is never allowed to grow past `maxFrameLength` before the
 * configured {@link OversizePolicy} reacts, so a stream that never sends a delimiter cannot grow
 * memory usage without bound.
 */
export class DelimiterFramer implements Framer {
  private readonly delimiter: Uint8Array;
  private readonly maxFrameLength: number;
  private readonly onOversize: OversizePolicy;
  private pending = new AppendBuffer();
  private searchFrom = 0;
  private skipping = false;
  private skipCarry = new Uint8Array(0);

  constructor(delimiter: Uint8Array | string, options: DelimiterFramerOptions = {}) {
    const bytes = typeof delimiter === 'string' ? utf8Encode(delimiter) : delimiter;
    if (bytes.length === 0) throw new ValueTypeError('a frame delimiter must not be empty');
    this.delimiter = bytes;
    this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    this.onOversize = options.onOversize ?? 'error';
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    if (chunk.length === 0) return frames;

    let rest: Uint8Array | undefined = chunk;
    if (this.skipping) {
      rest = this.resyncSkip(chunk);
      if (rest === undefined) return frames;
    }
    if (rest.length > 0) this.pending.append(rest);

    for (;;) {
      const view = this.pending.view();
      const idx = findDelimiterFrom(view, this.searchFrom, this.delimiter);
      if (idx !== -1) {
        this.emitFrame(view, idx, frames);
        this.pending.consume(idx + this.delimiter.length);
        this.searchFrom = 0;
        continue;
      }
      if (view.length > this.maxFrameLength) {
        this.handleUnterminatedOversize(view, frames);
      } else {
        this.searchFrom = Math.max(0, view.length - this.delimiter.length + 1);
      }
      break;
    }
    return frames;
  }

  finish(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    if (!this.skipping && this.pending.length > 0) {
      const view = this.pending.view();
      if (view.length > this.maxFrameLength) {
        this.reactToOversize(view.length, view, frames);
      } else {
        frames.push(view.slice());
      }
    }
    this.reset();
    return frames;
  }

  reset(): void {
    this.pending.clear();
    this.searchFrom = 0;
    this.skipping = false;
    this.skipCarry = new Uint8Array(0);
  }

  private emitFrame(view: Uint8Array, idx: number, frames: Uint8Array[]): void {
    if (idx <= this.maxFrameLength) {
      frames.push(view.slice(0, idx));
      return;
    }
    this.reactToOversize(idx, view, frames);
  }

  private handleUnterminatedOversize(view: Uint8Array, frames: Uint8Array[]): void {
    this.reactToOversize(view.length, view, frames);
    this.pending.clear();
    this.searchFrom = 0;
    this.skipping = true;
  }

  private reactToOversize(frameLength: number, view: Uint8Array, frames: Uint8Array[]): void {
    if (this.onOversize === 'error') {
      throw new LimitExceededError(
        'frame.length',
        this.maxFrameLength,
        `frame of ${frameLength} byte(s) exceeds the ${this.maxFrameLength}-byte limit`,
      );
    }
    if (this.onOversize === 'truncate') frames.push(view.slice(0, this.maxFrameLength));
  }

  /** While skipping an oversize, undelimited frame, scans new bytes for the delimiter without
   * re-buffering the discarded content (only the last `delimiter.length - 1` bytes are kept, in
   * case the delimiter straddles a chunk boundary). */
  private resyncSkip(chunk: Uint8Array): Uint8Array | undefined {
    const combined = this.skipCarry.length === 0 ? chunk : concatBytes([this.skipCarry, chunk]);
    const idx = findDelimiterFrom(combined, 0, this.delimiter);
    if (idx === -1) {
      const keep = Math.min(combined.length, this.delimiter.length - 1);
      this.skipCarry = combined.slice(combined.length - keep);
      return undefined;
    }
    this.skipping = false;
    this.skipCarry = new Uint8Array(0);
    return combined.slice(idx + this.delimiter.length);
  }
}

/** Finds the first occurrence of `delimiter` in `view` at or after `from`, or -1. */
export function findDelimiterFrom(view: Uint8Array, from: number, delimiter: Uint8Array): number {
  const limit = view.length - delimiter.length;
  outer: for (let i = Math.max(0, from); i <= limit; i++) {
    for (let j = 0; j < delimiter.length; j++) {
      if (view[i + j] !== delimiter[j]) continue outer;
    }
    return i;
  }
  return -1;
}
