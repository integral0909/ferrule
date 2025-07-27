/**
 * Incrementally splits a byte stream into discrete frames (lines, length-prefixed messages,
 * octet-counted syslog datagrams, ...).
 *
 * Implementations are safe to call with a stream chopped into chunks of any size, including one
 * byte at a time: the sequence of frames returned across all `push`/`finish` calls depends only
 * on the concatenation of the pushed bytes, never on how they were split. This "chunk-splitting
 * invariance" is exercised by property tests for every framer in this package.
 */
export interface Framer {
  /** Feeds a chunk of bytes, returning zero or more complete frames extracted so far. */
  push(chunk: Uint8Array): Uint8Array[];
  /**
   * Signals end of stream. Returns any final frame the framer can still recover (for example a
   * trailing, unterminated line), or an empty array. Some framers (length-prefixed ones, where a
   * partial frame cannot be recovered) throw if bytes remain buffered when the stream ends.
   */
  finish(): Uint8Array[];
  /** Discards buffered state, as if the framer had just been constructed. */
  reset(): void;
}

/**
 * What a framer does when a frame would exceed its configured size limit:
 *
 * - `error` (default for most framers): raise {@link LimitExceededError} immediately.
 * - `truncate`: emit the first `maxFrameLength` bytes as the frame and discard the rest, up to
 *   (and including) the next delimiter.
 * - `skip`: discard the whole oversize frame and emit nothing for it.
 */
export type OversizePolicy = 'error' | 'truncate' | 'skip';
