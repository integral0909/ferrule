import {
  createMetadata,
  LimitExceededError,
  LogEvent,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyValue } from '../value_text.js';

const CODEC = 'keyvalue';

export interface KeyValueOptions {
  /** Character that separates pairs. Default `' '` (any run of spaces is treated as one separator). */
  pairSeparator?: string;
  /** Character that separates a key from its value. Default `'='`. */
  kvSeparator?: string;
  /** Quote character recognised around values (disables quote-awareness if `''`). Default `'"'`. */
  quote?: string;
  /** Maximum number of pairs. Default 1024. */
  maxPairs?: number;
  /** Maximum input length in UTF-16 code units. Default 1 MiB. */
  maxLength?: number;
}

const DEFAULT_MAX_PAIRS = 1024;
const DEFAULT_MAX_LENGTH = 1024 * 1024;

function fail(message: string, offset?: number): never {
  throw new CodecSyntaxError(CODEC, 'E_KEYVALUE_SYNTAX', message, offset);
}

/**
 * A configurable `key=value` line parser, more general than {@link parseLogfmt}: the pair
 * separator, key/value separator, and quote character are all adjustable, so it also reads
 * formats like `k1=v1; k2=v2` (semicolon-separated, e.g. connection strings) or `k1:v1,k2:v2`.
 *
 * Quoted values (delimited by `quote`, when non-empty) may contain the pair separator; `\"` and
 * `\\` are unescaped inside them. A bare key with no `kvSeparator` before the next pair separator
 * decodes to an empty string value (unlike logfmt, which treats it as a flag) — pass a `boolean`
 * default of your own if you need flag semantics.
 */
export function parseKeyValue(text: string, options: KeyValueOptions = {}): Map<string, string> {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (text.length > maxLength) throw new LimitExceededError('keyvalue.length', maxLength);
  const pairSep = options.pairSeparator ?? ' ';
  const kvSep = options.kvSeparator ?? '=';
  const quote = options.quote ?? '"';
  const maxPairs = options.maxPairs ?? DEFAULT_MAX_PAIRS;
  if (pairSep.length !== 1) fail('pairSeparator must be exactly one character');
  if (kvSep.length !== 1) fail('kvSeparator must be exactly one character');
  if (quote.length > 1) fail('quote must be empty or exactly one character');

  const out = new Map<string, string>();
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    while (pos < n && text[pos] === pairSep) pos++;
    if (pos >= n) break;
    if (out.size >= maxPairs) throw new LimitExceededError('keyvalue.pairs', maxPairs);

    const keyStart = pos;
    while (pos < n && text[pos] !== kvSep && text[pos] !== pairSep) pos++;
    const key = text.slice(keyStart, pos).trim();
    if (key === '') fail('expected a key', keyStart);

    if (text[pos] === kvSep) {
      pos++;
      if (quote !== '' && text[pos] === quote) {
        const { value, next } = readQuoted(text, pos, quote);
        out.set(key, value);
        pos = next;
      } else {
        const valueStart = pos;
        while (pos < n && text[pos] !== pairSep) pos++;
        out.set(key, text.slice(valueStart, pos).trim());
      }
    } else {
      out.set(key, '');
    }
  }
  return out;
}

function readQuoted(text: string, start: number, quote: string): { value: string; next: number } {
  let pos = start + 1;
  let value = '';
  while (pos < text.length && text[pos] !== quote) {
    if (text[pos] === '\\' && (text[pos + 1] === quote || text[pos + 1] === '\\')) {
      value += text[pos + 1];
      pos += 2;
      continue;
    }
    value += text[pos];
    pos++;
  }
  if (text[pos] !== quote) fail('unterminated quoted value', pos);
  return { value, next: pos + 1 };
}

/** Quotes `value` (with `quote`) if it contains the pair or key/value separator, is empty, or
 * already contains the quote character; otherwise returns it unchanged. */
export function quoteKeyValue(
  value: string,
  pairSep: string,
  kvSep: string,
  quote: string,
): string {
  const needsQuoting =
    value === '' ||
    value.includes(pairSep) ||
    value.includes(kvSep) ||
    (quote !== '' && value.includes(quote));
  if (!needsQuoting || quote === '') return value;
  let out = quote;
  for (const c of value) {
    if (c === quote || c === '\\') out += `\\${c}`;
    else out += c;
  }
  return out + quote;
}

export type KeyValueEncodeOptions = Pick<
  KeyValueOptions,
  'pairSeparator' | 'kvSeparator' | 'quote'
>;

/** Encodes key/value pairs using the same separator conventions {@link parseKeyValue} accepts. */
export function encodeKeyValue(
  entries: Iterable<[string, Value]>,
  options: KeyValueEncodeOptions = {},
): string {
  const pairSep = options.pairSeparator ?? ' ';
  const kvSep = options.kvSeparator ?? '=';
  const quote = options.quote ?? '"';
  const parts: string[] = [];
  for (const [key, value] of entries) {
    parts.push(`${key}${kvSep}${quoteKeyValue(stringifyValue(value), pairSep, kvSep, quote)}`);
  }
  return parts.join(pairSep);
}

/** Decodes one key/value line directly into a {@link LogEvent} (each key becomes a top-level
 * string field). */
export function decodeKeyValueToLogEvent(text: string, options: KeyValueOptions = {}): LogEvent {
  const record = parseKeyValue(text, options);
  const fields: ValueMap = new Map();
  for (const [key, value] of record) fields.set(key, value);
  return new LogEvent(fields, createMetadata());
}
