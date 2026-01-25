import { SinkError } from '@ferrule/runtime';

/**
 * Parses an HTTP `Retry-After` header, which is either an integer number of seconds or an
 * HTTP-date (RFC 7231 §7.1.3). Returns milliseconds, or `undefined` if the header is absent or
 * unparseable. A date in the past clamps to zero rather than being rejected.
 */
export function parseRetryAfter(
  value: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}

/** Classifies an HTTP response status into a delivery outcome, following the convention this
 * whole sink family shares: `429`/`5xx` (and `408`) are retryable, honouring `Retry-After` as a
 * floor on the computed backoff; every other `4xx` is permanent. `2xx` returns `undefined`
 * (success — nothing to classify). */
export function classifyHttpStatus(
  status: number,
  options: { body?: string; retryAfterMs?: number; code?: string } = {},
): SinkError | undefined {
  if (status >= 200 && status < 300) return undefined;
  const detail =
    options.body !== undefined && options.body !== '' ? `: ${truncate(options.body)}` : '';
  const message = `HTTP ${status}${detail}`;
  const code = options.code ?? 'E_HTTP_STATUS';
  if (status === 429 || status === 408 || status >= 500) {
    return SinkError.retryable(code, message, {
      ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    });
  }
  return SinkError.permanent(code, message);
}

function truncate(text: string, max = 512): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
