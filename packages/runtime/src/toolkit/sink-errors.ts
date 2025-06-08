import { FerruleError } from '@ferrule/core';

export interface SinkErrorInit {
  readonly retryable: boolean;
  /** A server-provided minimum backoff (e.g. HTTP `Retry-After`), in milliseconds. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * An error a sink's `send` raises to control retry behaviour. {@link runBatchedSink} (and any
 * sink built on this toolkit) inspects {@link retryable} to decide between retrying
 * (`errored` if retries are exhausted) and giving up immediately (`rejected`).
 */
export class SinkError extends FerruleError {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, init: SinkErrorInit) {
    super(code, message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'SinkError';
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs;
  }

  static retryable(
    code: string,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ): SinkError {
    return new SinkError(code, message, { retryable: true, ...options });
  }

  static permanent(code: string, message: string, cause?: unknown): SinkError {
    return new SinkError(code, message, { retryable: false, cause });
  }
}

/**
 * Normalizes anything a sink's `send` might throw into a {@link SinkError}. Errors that are
 * already a `SinkError` pass through; everything else (network errors, timeouts, unexpected
 * exceptions) is treated as retryable, since permanence must be asserted explicitly.
 */
export function classifySinkError(error: unknown): SinkError {
  if (error instanceof SinkError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SinkError('E_SINK_ERROR', message, { retryable: true, cause: error });
}
