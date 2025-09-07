import { FerruleError } from '@ferrule/core';

/**
 * Raised when binary input to {@link decodeEvent}/{@link decodeEventBatch} (or a lower-level
 * reader) ends before the structure it is decoding is complete. Always recoverable: the caller
 * knows exactly how many more bytes it needs, if it wants to retry with more data.
 */
export class CodecTruncatedError extends FerruleError {
  constructor(message = 'truncated input') {
    super('E_CODEC_TRUNCATED', message);
    this.name = 'CodecTruncatedError';
  }
}

/** Raised when binary input contains a structurally invalid encoding (bad tag, bad enum, ...). */
export class CodecMalformedError extends FerruleError {
  constructor(message: string) {
    super('E_CODEC_MALFORMED', message);
    this.name = 'CodecMalformedError';
  }
}

/** Raised when binary input exceeds a configured decode limit (depth, length, element count). */
export class CodecLimitExceededError extends FerruleError {
  readonly limit: string;
  readonly max: number;

  constructor(limit: string, max: number) {
    super('E_CODEC_LIMIT', `codec limit exceeded: ${limit} (max ${max})`);
    this.name = 'CodecLimitExceededError';
    this.limit = limit;
    this.max = max;
  }
}

/** Raised when a binary envelope declares a format version this build does not understand. */
export class CodecVersionError extends FerruleError {
  readonly version: number;

  constructor(version: number) {
    super('E_CODEC_VERSION', `unsupported encoding version: ${version}`);
    this.name = 'CodecVersionError';
    this.version = version;
  }
}

/** Raised when a filesystem operation fails because a test injected a fault. */
export class FileSystemFaultError extends FerruleError {
  constructor(message: string, options?: ErrorOptions) {
    super('E_FS_FAULT', message, options);
    this.name = 'FileSystemFaultError';
  }
}

/** Raised when an operation is attempted on a buffer that has already been closed. */
export class BufferClosedError extends FerruleError {
  constructor(message = 'the buffer is closed') {
    super('E_BUFFER_CLOSED', message);
    this.name = 'BufferClosedError';
  }
}

/**
 * Raised by {@link BufferWriter.write} when `whenFull` is `'drop_newest'` and the buffer does
 * not have room for the write. The caller should finalize the rejected events itself (typically
 * with `'rejected'` or `'errored'`) since the buffer never took ownership of them.
 */
export class BufferFullError extends FerruleError {
  constructor(message = 'the buffer is full') {
    super('E_BUFFER_FULL', message);
    this.name = 'BufferFullError';
  }
}

/** Raised when a pending operation is cancelled by an {@link AbortSignal}. */
export class BufferAbortedError extends FerruleError {
  constructor(message = 'aborted') {
    super('E_BUFFER_ABORTED', message);
    this.name = 'BufferAbortedError';
  }
}

/** Raised when a single event's encoded form exceeds the configured maximum record size. */
export class RecordTooLargeError extends FerruleError {
  readonly size: number;
  readonly max: number;

  constructor(size: number, max: number) {
    super('E_RECORD_TOO_LARGE', `encoded event is ${size} bytes, exceeding the ${max} byte limit`);
    this.name = 'RecordTooLargeError';
    this.size = size;
    this.max = max;
  }
}

/** Raised when the on-disk ledger (checkpoint) file exists but cannot be parsed. */
export class LedgerCorruptError extends FerruleError {
  constructor(message: string, options?: ErrorOptions) {
    super('E_LEDGER_CORRUPT', message, options);
    this.name = 'LedgerCorruptError';
  }
}

/**
 * Raised when a segment file's header or record framing is invalid in a way that recovery's
 * documented policy does not tolerate (see `FORMAT.md`). Recovery itself does not throw this for
 * routine corruption it knows how to handle (a torn tail record, an isolated bad checksum in the
 * middle of a segment); those are counted and reported instead.
 */
export class SegmentCorruptError extends FerruleError {
  constructor(message: string, options?: ErrorOptions) {
    super('E_SEGMENT_CORRUPT', message, options);
    this.name = 'SegmentCorruptError';
  }
}
