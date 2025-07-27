import {
  createMetadata,
  LimitExceededError,
  LogEvent,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyValue } from '../value_text.js';

const CODEC = 'logfmt';

export interface LogfmtDecodeOptions {
  /** Maximum number of key/value pairs per line. Default 1024. */
  maxPairs?: number;
  /** Maximum input length in UTF-16 code units. Default 1 MiB. */
  maxLength?: number;
}

/** One decoded logfmt line: bare (valueless) keys decode to `true`, everything else to a string. */
export type LogfmtRecord = Map<string, string | boolean>;

const DEFAULT_MAX_PAIRS = 1024;
const DEFAULT_MAX_LENGTH = 1024 * 1024;

function fail(message: string, offset?: number): never {
  throw new CodecSyntaxError(CODEC, 'E_LOGFMT_SYNTAX', message, offset);
}

/**
 * Parses one line of `key=value key2="quoted value" flag` logfmt text (the format used by Heroku,
 * many Go services, and HAProxy). Bare (unquoted) values run until the next whitespace; quoted
 * values use backslash escapes (`\"`, `\\`, `\n`, `\t`, `\r`, `\uXXXX`). A key with no `=` decodes
 * to boolean `true` (a flag). Malformed quoting raises {@link CodecSyntaxError}; well-formed input
 * of any content never throws anything else.
 */
export function parseLogfmt(line: string, options: LogfmtDecodeOptions = {}): LogfmtRecord {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (line.length > maxLength) throw new LimitExceededError('logfmt.length', maxLength);
  const maxPairs = options.maxPairs ?? DEFAULT_MAX_PAIRS;

  const out: LogfmtRecord = new Map();
  let pos = 0;
  const n = line.length;

  const skipSpace = (): void => {
    while (pos < n && isSpace(line.charCodeAt(pos))) pos++;
  };

  skipSpace();
  while (pos < n) {
    if (out.size >= maxPairs) throw new LimitExceededError('logfmt.pairs', maxPairs);
    const keyStart = pos;
    while (pos < n && !isSpace(line.charCodeAt(pos)) && line[pos] !== '=') pos++;
    if (pos === keyStart) fail('expected a key', pos);
    const key = line.slice(keyStart, pos);

    if (line[pos] === '=') {
      pos++;
      if (pos < n && line[pos] === '"') {
        const { value, next } = parseQuoted(line, pos);
        out.set(key, value);
        pos = next;
      } else {
        const valueStart = pos;
        while (pos < n && !isSpace(line.charCodeAt(pos))) pos++;
        out.set(key, line.slice(valueStart, pos));
      }
    } else {
      out.set(key, true);
    }
    skipSpace();
  }
  return out;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function parseQuoted(text: string, start: number): { value: string; next: number } {
  let pos = start + 1; // skip opening quote
  let value = '';
  while (pos < text.length && text[pos] !== '"') {
    const c = text[pos];
    if (c === '\\') {
      const e = text[pos + 1];
      switch (e) {
        case '"':
          value += '"';
          pos += 2;
          continue;
        case '\\':
          value += '\\';
          pos += 2;
          continue;
        case 'n':
          value += '\n';
          pos += 2;
          continue;
        case 't':
          value += '\t';
          pos += 2;
          continue;
        case 'r':
          value += '\r';
          pos += 2;
          continue;
        case 'u': {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape', pos);
          value += String.fromCharCode(parseInt(hex, 16));
          pos += 6;
          continue;
        }
        default:
          fail(`invalid escape sequence "\\${e ?? ''}"`, pos);
      }
    }
    value += c;
    pos++;
  }
  if (text[pos] !== '"') fail('unterminated quoted value', pos);
  return { value, next: pos + 1 };
}

const BARE_SAFE = /^[^\s="]+$/;

/** Escapes and quotes `value` only if needed to round-trip through {@link parseLogfmt}. */
export function quoteLogfmtValue(value: string): string {
  if (value !== '' && BARE_SAFE.test(value)) return value;
  let out = '"';
  for (const c of value) {
    if (c === '"' || c === '\\') out += `\\${c}`;
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else out += c;
  }
  return `${out}"`;
}

export interface LogfmtEncodeOptions {
  /** When `true` (default), a boolean `true` value encodes as a bare key with no `=value`. */
  boolValueless?: boolean;
}

/** Encodes key/value pairs as one logfmt line (no trailing newline). */
export function encodeLogfmt(
  entries: Iterable<[string, Value]>,
  options: LogfmtEncodeOptions = {},
): string {
  const boolValueless = options.boolValueless ?? true;
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (boolValueless && value === true) {
      parts.push(key);
      continue;
    }
    parts.push(`${key}=${quoteLogfmtValue(stringifyValue(value))}`);
  }
  return parts.join(' ');
}

/** Decodes one logfmt line directly into a {@link LogEvent}: each key becomes a top-level field
 * (a flag key's value is the boolean `true`, everything else a string). */
export function decodeLogfmtToLogEvent(line: string, options: LogfmtDecodeOptions = {}): LogEvent {
  const record = parseLogfmt(line, options);
  const fields: ValueMap = new Map();
  for (const [key, value] of record) fields.set(key, value);
  return new LogEvent(fields, createMetadata());
}

/** Encodes a {@link LogEvent}'s top-level fields as one logfmt line. Nested arrays/objects are
 * flattened to their JSON text via {@link stringifyValue}. */
export function encodeLogEventAsLogfmt(event: LogEvent, options: LogfmtEncodeOptions = {}): string {
  return encodeLogfmt(event.fields, options);
}
