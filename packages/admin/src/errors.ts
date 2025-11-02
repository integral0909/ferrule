import { FerruleError } from '@ferrule/core';

/**
 * Errors the admin HTTP layer translates directly into a response. `status` is the HTTP status
 * code; `message` is written straight into the JSON error envelope, so it must never contain a
 * stack trace or anything else unsafe to show a client.
 */
export class AdminError extends FerruleError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
  ) {
    super(code, message);
    this.name = 'AdminError';
  }
}

export class BadRequestError extends AdminError {
  constructor(message: string) {
    super(400, 'E_BAD_REQUEST', message);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends AdminError {
  constructor(message = 'a valid bearer token is required') {
    super(401, 'E_UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

/** Raised by the DNS-rebinding guard: the request's `Host` header names a host that isn't allowed. */
export class ForbiddenHostError extends AdminError {
  constructor(host: string | undefined) {
    super(403, 'E_FORBIDDEN_HOST', `request Host ${JSON.stringify(host ?? '')} is not allowed`);
    this.name = 'ForbiddenHostError';
  }
}

export class NotFoundError extends AdminError {
  constructor(message = 'not found') {
    super(404, 'E_NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** Raised when an endpoint depends on a callback (`onReload`, `configDump`) the embedder never
 * supplied to {@link createAdminServer}. */
export class NotConfiguredError extends AdminError {
  constructor(message: string) {
    super(404, 'E_NOT_CONFIGURED', message);
    this.name = 'NotConfiguredError';
  }
}

export class MethodNotAllowedError extends AdminError {
  readonly allowed: readonly string[];

  constructor(allowed: readonly string[]) {
    super(405, 'E_METHOD_NOT_ALLOWED', `method not allowed (allowed: ${allowed.join(', ')})`);
    this.name = 'MethodNotAllowedError';
    this.allowed = allowed;
  }
}

export class PayloadTooLargeError extends AdminError {
  constructor(maxBytes: number) {
    super(413, 'E_PAYLOAD_TOO_LARGE', `request body exceeds the ${maxBytes} byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

export class RequestTimeoutError extends AdminError {
  constructor() {
    super(408, 'E_REQUEST_TIMEOUT', 'the request took too long to handle');
    this.name = 'RequestTimeoutError';
  }
}
