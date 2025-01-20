/**
 * Base class for all errors raised by Ferrule. Every error carries a stable,
 * machine-readable `code`; messages are for humans and may change between versions.
 */
export class FerruleError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FerruleError';
    this.code = code;
  }
}

/** Raised when textual input (a timestamp, duration, path, JSON document, ...) is malformed. */
export class ParseError extends FerruleError {
  /** Zero-based offset into the input where the problem was detected, if known. */
  readonly offset: number | undefined;

  constructor(code: string, message: string, offset?: number, options?: ErrorOptions) {
    super(code, offset === undefined ? message : `${message} (at offset ${offset})`, options);
    this.name = 'ParseError';
    this.offset = offset;
  }
}

/** Raised when an operation receives a value of the wrong kind. */
export class ValueTypeError extends FerruleError {
  constructor(message: string, options?: ErrorOptions) {
    super('E_VALUE_TYPE', message, options);
    this.name = 'ValueTypeError';
  }
}

/** Raised when input exceeds a configured safety limit (depth, size, count). */
export class LimitExceededError extends FerruleError {
  readonly limit: string;
  readonly max: number;

  constructor(limit: string, max: number, message?: string) {
    super('E_LIMIT_EXCEEDED', message ?? `limit exceeded: ${limit} (max ${max})`);
    this.name = 'LimitExceededError';
    this.limit = limit;
    this.max = max;
  }
}

export function isFerruleError(error: unknown): error is FerruleError {
  return error instanceof FerruleError;
}
