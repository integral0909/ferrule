import { LimitExceededError, ParseError } from '@ferrule/core';
import { LineIndex, type Range } from './position.js';
import {
  mappingNode,
  scalarNode,
  sequenceNode,
  type DocNode,
  type MappingEntry,
  type ScalarNode,
} from './yaml/nodes.js';

/**
 * A position-tracking JSON (RFC 8259) reader that produces the same {@link DocNode} tree the
 * YAML parser does, so config files can mix YAML and JSON freely and diagnostics work the same
 * way for both. JSON is not reused through the YAML parser: JSON allows constructs YAML's block
 * style does not (arbitrary nesting on one line, no comments, strict quoting) and the two
 * grammars are close enough to invite subtle bugs if conflated, so this is a small dedicated
 * reader instead.
 */

export interface JsonReadOptions {
  /** Maximum nesting depth of arrays/objects. Default 200. */
  maxDepth?: number;
  /** Maximum input length in UTF-16 code units. Default 8 MiB. */
  maxLength?: number;
}

const DEFAULT_MAX_DEPTH = 200;
const DEFAULT_MAX_LENGTH = 8 * 1024 * 1024;

export class JsonReadSyntaxError extends ParseError {
  readonly line: number;
  readonly column: number;

  constructor(code: string, message: string, offset: number, li: LineIndex) {
    const { line, column } = li.positionAt(offset);
    super(code, `${message} at line ${line}, column ${column}`, offset);
    this.name = 'JsonReadSyntaxError';
    this.line = line;
    this.column = column;
  }
}

/** Reads a JSON document into a position-tracked {@link DocNode} tree. */
export function readJsonDocument(text: string, options: JsonReadOptions = {}): DocNode {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (text.length > maxLength) throw new LimitExceededError('json.length', maxLength);
  return new JsonReader(text, options.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

class JsonReader {
  private pos = 0;
  private readonly len: number;
  private readonly li: LineIndex;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {
    this.len = text.length;
    this.li = new LineIndex(text);
  }

  parseDocument(): DocNode {
    this.skipWs();
    const value = this.parseValue(0);
    this.skipWs();
    if (this.pos < this.len) this.fail('unexpected trailing content');
    return value;
  }

  private parseValue(depth: number): DocNode {
    const c = this.text.charCodeAt(this.pos);
    switch (c) {
      case 0x7b:
        return this.parseObject(depth + 1);
      case 0x5b:
        return this.parseArray(depth + 1);
      case 0x22:
        return this.parseStringNode();
      case 0x74:
        return this.parseLiteral('true', true);
      case 0x66:
        return this.parseLiteral('false', false);
      case 0x6e:
        return this.parseLiteral('null', null);
      default:
        if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.parseNumber();
        if (Number.isNaN(c)) this.fail('unexpected end of input');
        this.fail(`unexpected character ${JSON.stringify(this.text[this.pos])}`);
    }
  }

  private parseObject(depth: number): DocNode {
    if (depth > this.maxDepth) throw new LimitExceededError('json.depth', this.maxDepth);
    const start = this.pos;
    this.pos++;
    const entries: MappingEntry[] = [];
    const seen = new Map<string, Range>();
    this.skipWs();
    if (this.text.charCodeAt(this.pos) === 0x7d) {
      this.pos++;
      return mappingNode(entries, this.range(start, this.pos));
    }
    for (;;) {
      if (this.text.charCodeAt(this.pos) !== 0x22) this.fail('expected a string key');
      const key = this.parseStringNode();
      this.skipWs();
      if (this.text.charCodeAt(this.pos) !== 0x3a) this.fail('expected ":"');
      this.pos++;
      this.skipWs();
      const value = this.parseValue(depth);
      const keyText = String(key.value);
      const existing = seen.get(keyText);
      if (existing !== undefined) {
        this.fail(
          `duplicate key ${JSON.stringify(keyText)} (first used at line ${existing.start.line}, column ${existing.start.column})`,
          key.range.start.offset,
        );
      }
      seen.set(keyText, key.range);
      entries.push({ key, value });
      this.skipWs();
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x2c) {
        this.pos++;
        this.skipWs();
      } else if (c === 0x7d) {
        this.pos++;
        return mappingNode(entries, this.range(start, this.pos));
      } else {
        this.fail('expected "," or "}"');
      }
    }
  }

  private parseArray(depth: number): DocNode {
    if (depth > this.maxDepth) throw new LimitExceededError('json.depth', this.maxDepth);
    const start = this.pos;
    this.pos++;
    const items: DocNode[] = [];
    this.skipWs();
    if (this.text.charCodeAt(this.pos) === 0x5d) {
      this.pos++;
      return sequenceNode(items, this.range(start, this.pos));
    }
    for (;;) {
      items.push(this.parseValue(depth));
      this.skipWs();
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x2c) {
        this.pos++;
        this.skipWs();
      } else if (c === 0x5d) {
        this.pos++;
        return sequenceNode(items, this.range(start, this.pos));
      } else {
        this.fail('expected "," or "]"');
      }
    }
  }

  private parseStringNode(): ScalarNode {
    const start = this.pos;
    const text = this.parseStringText();
    return scalarNode(text, 'double', this.range(start, this.pos));
  }

  private parseStringText(): string {
    const text = this.text;
    const start = ++this.pos;
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        this.pos = i + 1;
        return text.slice(start, i);
      }
      if (c === 0x5c) return this.parseStringSlow(start);
      if (c < 0x20) {
        this.pos = i;
        this.fail('unescaped control character in string');
      }
    }
    this.pos = text.length;
    this.fail('unterminated string');
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
    this.fail('unterminated string');
  }

  private parseNumber(): DocNode {
    const start = this.pos;
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.text);
    if (m === null) this.fail('invalid number');
    const literal = m[0];
    this.pos += literal.length;
    const next = this.text.charCodeAt(this.pos);
    if (next >= 0x30 && next <= 0x39) this.fail('leading zeros are not allowed');
    let value: number | bigint;
    if (m[1] === undefined && m[2] === undefined) {
      const n = BigInt(literal);
      value = n >= MIN_SAFE && n <= MAX_SAFE ? Number(n) : n;
    } else {
      value = Number(literal);
    }
    return scalarNode(value, 'plain', this.range(start, this.pos));
  }

  private parseLiteral<T extends null | boolean>(word: string, value: T): DocNode {
    const start = this.pos;
    if (!this.text.startsWith(word, this.pos)) this.fail('invalid literal');
    this.pos += word.length;
    return scalarNode(value, 'plain', this.range(start, this.pos));
  }

  private skipWs(): void {
    const text = this.text;
    let i = this.pos;
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
    this.pos = i;
  }

  private range(start: number, end: number): Range {
    return this.li.rangeAt(start, end);
  }

  private fail(message: string, at: number = this.pos): never {
    throw new JsonReadSyntaxError('E_JSON_SYNTAX', message, at, this.li);
  }
}
