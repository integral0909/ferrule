import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ForbiddenHostError, UnauthorizedError } from './errors.js';
import type { AdminAuthOptions, BoundAddress } from './types.js';

const BEARER_PREFIX = 'Bearer ';

/** Hashes to a fixed 32-byte digest before comparing, so `timingSafeEqual` (which requires equal-
 * length buffers) works regardless of the two strings' lengths, and so neither the token's length
 * nor its content is observable through timing. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function secureEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? undefined : token;
}

/** Throws {@link UnauthorizedError} unless `req` carries the configured bearer token. The token
 * itself is never logged, including on failure. */
export function requireAuth(req: IncomingMessage, auth: AdminAuthOptions): void {
  const provided = extractBearerToken(req);
  if (provided === undefined || !secureEquals(provided, auth.token)) {
    throw new UnauthorizedError();
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function loopbackHostNames(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/**
 * DNS-rebinding protection: when the server is bound to a loopback address, only accepts requests
 * whose `Host` header names the loopback address at the bound port, or one of `extraAllowedHosts`
 * (case-insensitive, compared exactly). A server bound to a non-loopback address skips this check
 * entirely — the operator has already made a deliberate choice to expose it.
 */
export function checkHost(
  req: IncomingMessage,
  bound: BoundAddress,
  extraAllowedHosts: readonly string[],
): void {
  if (!isLoopbackHost(bound.host)) return;
  const header = req.headers.host;
  const allowed = loopbackHostNames(bound.port);
  for (const extra of extraAllowedHosts) allowed.add(extra.toLowerCase());
  if (header === undefined || !allowed.has(header.toLowerCase())) {
    throw new ForbiddenHostError(header);
  }
}
