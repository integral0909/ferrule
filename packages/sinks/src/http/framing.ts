import { concatBytes, utf8Encode } from '@ferrule/core';

/** How a batch of already-encoded per-event byte chunks is joined into one request body. */
export type BatchFraming = 'ndjson' | 'json_array' | 'newline';

const NEWLINE = utf8Encode('\n');
const COMMA = utf8Encode(',');
const OPEN = utf8Encode('[');
const CLOSE = utf8Encode(']');

/**
 * Joins per-event encoded chunks into one request body per {@link BatchFraming}: `ndjson` is one
 * JSON value per line with a trailing newline, `newline` is the same joining with no trailing
 * newline (for arbitrary, non-JSON text framing), and `json_array` wraps the chunks (each
 * expected to already be a JSON value) in `[...]` with `,` separators.
 */
export function frameChunks(chunks: readonly Uint8Array[], framing: BatchFraming): Uint8Array {
  if (chunks.length === 0) {
    return framing === 'json_array' ? concatBytes([OPEN, CLOSE]) : new Uint8Array(0);
  }
  const parts: Uint8Array[] = [];
  if (framing === 'json_array') parts.push(OPEN);
  chunks.forEach((chunk, i) => {
    parts.push(chunk);
    const last = i === chunks.length - 1;
    if (framing === 'ndjson') parts.push(NEWLINE);
    else if (framing === 'json_array' && !last) parts.push(COMMA);
    else if (framing === 'newline' && !last) parts.push(NEWLINE);
  });
  if (framing === 'json_array') parts.push(CLOSE);
  return concatBytes(parts);
}

/** A reasonable default `Content-Type` for a body produced by {@link frameChunks}. */
export function contentTypeFor(framing: BatchFraming): string {
  switch (framing) {
    case 'ndjson':
      return 'application/x-ndjson';
    case 'newline':
      return 'text/plain; charset=utf-8';
    case 'json_array':
      return 'application/json';
  }
}
