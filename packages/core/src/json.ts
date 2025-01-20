import { FerruleError, LimitExceededError, ParseError } from './errors.js';
import { Timestamp } from './timestamp.js';
import { formatFloat, INT64_MAX, INT64_MIN, type Value, type ValueMap } from './value.js';

export interface JsonParseOptions {
  /** Maximum nesting depth of arrays/objects. Default 128. */
  maxDepth?: number;
  /** Maximum input length in UTF-16 code units. Default 64 MiB. */
  maxLength?: number;
  /** What to do when an object repeats a key. Default `last` (matches `JSON.parse`). */
  duplicateKeys?: 'last' | 'first' | 'error';
}

/** Error raised for malformed JSON. Includes the 1-based line and column of the problem. */
export class JsonSyntaxError extends ParseError {
  readonly line: number;
  readonly column: number;

  constructor(message: string, text: string, offset: number) {
    const { line, column } = lineAndColumn(text, offset);
    super('E_JSON_SYNTAX', `${message} at line ${line}, column ${column}`);
    this.name = 'JsonSyntaxError';
    this.line = line;
    this.column = column;
  }
}

const DEFAULT_MAX_DEPTH = 128;
const DEFAULT_MAX_LENGTH = 64 * 1024 * 1024;

/**
 * Parses JSON (RFC 8259) into a {@link Value} without losing numeric information:
 *
 * - numbers without a fraction or exponent become integers (`bigint`) when they fit in int64,
 *   and floats otherwise;
 * - numbers with a fraction or exponent become floats, so `1.0` stays a float;
 * - objects become insertion-ordered `Map`s, so keys like `__proto__` are plain data.
 *
 * Input is bounded by `maxDepth` and `maxLength`; exceeding either raises
 * {@link LimitExceededError}.
 */
export function parseJson(text: string, options: JsonParseOptions = {}): Value {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (text.length > maxLength) throw new LimitExceededError('json.length', maxLength);
  const parser = new JsonParser(
    text,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    options.duplicateKeys ?? 'last',
  );
  return parser.parseDocument();
}

export type JsonParseResult = { ok: true; value: Value } | { ok: false; error: FerruleError };

/** Like {@link parseJson} but returns a result instead of throwing Ferrule errors. */
export function tryParseJson(text: string, options?: JsonParseOptions): JsonParseResult {
  try {
    return { ok: true, value: parseJson(text, options) };
  } catch (error) {
    if (error instanceof FerruleError) return { ok: false, error };
    throw error;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

class JsonParser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
    private readonly duplicateKeys: 'last' | 'first' | 'error',
  ) {}

  parseDocument(): Value {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos < this.text.length) this.fail('unexpected trailing content');
    return value;
  }

  private parseValue(depth: number): Value {
    const c = this.text.charCodeAt(this.pos);
    switch (c) {
      case 0x7b: // {
        return this.parseObject(depth + 1);
      case 0x5b: // [
        return this.parseArray(depth + 1);
      case 0x22: // "
        return this.parseString();
      case 0x74: // t
        return this.parseLiteral('true', true);
      case 0x66: // f
        return this.parseLiteral('false', false);
      case 0x6e: // n
        return this.parseLiteral('null', null);
      default:
        if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.parseNumber();
        if (Number.isNaN(c)) return this.fail('unexpected end of input');
        return this.fail(`unexpected character ${JSON.stringify(this.text[this.pos])}`);
    }
  }

  private parseObject(depth: number): ValueMap {
    if (depth > this.maxDepth) throw new LimitExceededError('json.depth', this.maxDepth);
    this.pos++; // {
    const out: ValueMap = new Map();
    this.skipWhitespace();
    if (this.text.charCodeAt(this.pos) === 0x7d) {
      this.pos++;
      return out;
    }
    for (;;) {
      if (this.text.charCodeAt(this.pos) !== 0x22) this.fail('expected a string key');
      const keyStart = this.pos;
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text.charCodeAt(this.pos) !== 0x3a) this.fail('expected ":"');
      this.pos++;
      this.skipWhitespace();
      const value = this.parseValue(depth);
      if (out.has(key)) {
        if (this.duplicateKeys === 'error') {
          this.pos = keyStart;
          this.fail(`duplicate key ${JSON.stringify(key)}`);
        }
        if (this.duplicateKeys === 'last') out.set(key, value);
      } else {
        out.set(key, value);
      }
      this.skipWhitespace();
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x2c) {
        this.pos++;
        this.skipWhitespace();
      } else if (c === 0x7d) {
        this.pos++;
        return out;
      } else {
        this.fail('expected "," or "}"');
      }
    }
  }

  private parseArray(depth: number): Value[] {
    if (depth > this.maxDepth) throw new LimitExceededError('json.depth', this.maxDepth);
    this.pos++; // [
    const out: Value[] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.pos) === 0x5d) {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue(depth));
      this.skipWhitespace();
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x2c) {
        this.pos++;
        this.skipWhitespace();
      } else if (c === 0x5d) {
        this.pos++;
        return out;
      } else {
        this.fail('expected "," or "]"');
      }
    }
  }

  private parseString(): string {
    const text = this.text;
    const start = ++this.pos; // skip opening quote
    // Fast path: no escapes.
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        this.pos = i + 1;
        return text.slice(start, i);
      }
      if (c === 0x5c) break;
      if (c < 0x20) {
        this.pos = i;
        this.fail('unescaped control character in string');
      }
    }
    return this.parseStringSlow(start);
  }

  private parseStringSlow(start: number): string {
    const text = this.text;
    let out = '';
    let chunkStart = start;
    let i = start;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        this.pos = i + 1;
        return out + text.slice(chunkStart, i);
      }
      if (c < 0x20) {
        this.pos = i;
        this.fail('unescaped control character in string');
      }
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(chunkStart, i);
      const e = text[i + 1];
      switch (e) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.pos = i;
            this.fail('invalid unicode escape');
          }
          // Surrogate pairs combine naturally because JS strings are UTF-16.
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          this.pos = i;
          this.fail('invalid escape sequence');
      }
      i += 2;
      chunkStart = i;
    }
    this.pos = text.length;
    return this.fail('unterminated string');
  }

  private parseNumber(): bigint | number {
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.text);
    if (m === null) return this.fail('invalid number');
    const literal = m[0];
    this.pos += literal.length;
    // A digit immediately after the match means a leading zero like "012".
    const next = this.text.charCodeAt(this.pos);
    if (next >= 0x30 && next <= 0x39) this.fail('leading zeros are not allowed');
    if (m[1] === undefined && m[2] === undefined) {
      const n = BigInt(literal);
      if (n >= INT64_MIN && n <= INT64_MAX) return n;
    }
    return Number(literal);
  }

  private parseLiteral<T extends Value>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) this.fail('invalid literal');
    this.pos += word.length;
    return value;
  }

  private skipWhitespace(): void {
    const text = this.text;
    let i = this.pos;
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
    this.pos = i;
  }

  private fail(message: string): never {
    throw new JsonSyntaxError(message, this.text, this.pos);
  }
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

export interface JsonEncodeOptions {
  /** Spaces of indentation for pretty output. Default 0 (compact). */
  indent?: number;
  /**
   * `preserve` (default) writes integral floats with a trailing `.0` so they parse back as
   * floats; `plain` writes them like JavaScript does (`1`).
   */
  floats?: 'preserve' | 'plain';
  /** Encoding for NaN and ±Infinity, which JSON cannot represent. Default `null`. */
  nonFinite?: 'null' | 'string' | 'error';
  /** Emit object keys in sorted order for deterministic output. Default false. */
  sortKeys?: boolean;
  /** Maximum nesting depth; guards against cyclic values. Default 128. */
  maxDepth?: number;
}

/**
 * Encodes a {@link Value} as JSON. Integers are written exactly, bytes as base64 strings, and
 * timestamps as RFC 3339 strings.
 */
export function encodeJson(value: Value, options: JsonEncodeOptions = {}): string {
  const indent = options.indent ?? 0;
  const preserveFloats = (options.floats ?? 'preserve') === 'preserve';
  const nonFinite = options.nonFinite ?? 'null';
  const sortKeys = options.sortKeys ?? false;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const encode = (v: Value, depth: number, pad: string): string => {
    switch (typeof v) {
      case 'boolean':
        return v ? 'true' : 'false';
      case 'bigint':
        return v.toString();
      case 'number':
        if (!Number.isFinite(v)) {
          if (nonFinite === 'error') {
            throw new FerruleError('E_JSON_NON_FINITE', `cannot encode ${v} as JSON`);
          }
          return nonFinite === 'null' ? 'null' : JSON.stringify(String(v));
        }
        return preserveFloats ? formatFloat(v) : String(v);
      case 'string':
        return JSON.stringify(v);
      case 'object': {
        if (v === null) return 'null';
        if (v instanceof Timestamp) return `"${v.toISOString()}"`;
        if (v instanceof Uint8Array) {
          return `"${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')}"`;
        }
        if (depth >= maxDepth) throw new LimitExceededError('json.depth', maxDepth);
        const inner = indent > 0 ? pad + ' '.repeat(indent) : '';
        const nl = indent > 0 ? '\n' : '';
        const colon = indent > 0 ? ': ' : ':';
        if (Array.isArray(v)) {
          if (v.length === 0) return '[]';
          const items = v.map((item) => inner + encode(item, depth + 1, inner));
          return `[${nl}${items.join(`,${nl}`)}${nl}${pad}]`;
        }
        if (v.size === 0) return '{}';
        const keys = sortKeys ? [...v.keys()].sort() : [...v.keys()];
        const members = keys.map(
          (k) => `${inner}${JSON.stringify(k)}${colon}${encode(v.get(k)!, depth + 1, inner)}`,
        );
        return `{${nl}${members.join(`,${nl}`)}${nl}${pad}}`;
      }
      default:
        throw new FerruleError('E_JSON_ENCODE', `cannot encode a ${typeof v} as JSON`);
    }
  };
  return encode(value, 0, '');
}
