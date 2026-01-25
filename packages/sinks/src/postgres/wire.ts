import { LimitExceededError } from '@ferrule/core';

/**
 * PostgreSQL wire protocol v3 primitives (see the "Frontend/Backend Protocol" chapter of the
 * PostgreSQL documentation). A frontend message is `<1-byte type><Int32 length, self-inclusive,
 * excludes the type byte><payload>`; the initial `StartupMessage` and `SSLRequest`/
 * `CancelRequest` are the only messages with no leading type byte. A backend message has the
 * same shape as an ordinary frontend message.
 */

const PROTOCOL_VERSION_3_0 = 196608; // 3 << 16 | 0
export const SSL_REQUEST_CODE = 80877103;

/** Builds frontend messages and startup/SSL-request pseudo-messages field by field. */
export class PgWriter {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  private push(buf: Buffer): this {
    this.chunks.push(buf);
    this.length += buf.length;
    return this;
  }

  int8(value: number): this {
    return this.push(Buffer.from([value & 0xff]));
  }

  int16(value: number): this {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value, 0);
    return this.push(b);
  }

  int32(value: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value, 0);
    return this.push(b);
  }

  /** A null-terminated string. */
  cstring(value: string): this {
    return this.push(Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]));
  }

  /** Raw bytes with no length prefix or terminator (caller manages framing, e.g. after writing
   * an explicit `int32` length for a `Bind` parameter). */
  bytes(value: Uint8Array): this {
    return this.push(Buffer.from(value));
  }

  build(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

/** Wraps `body` as a complete frontend message: `<type><length><body>`. */
export function frontendMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 1, 'ascii');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body], 5 + body.length);
}

/** The `StartupMessage`: no type byte, protocol version, then `name\0value\0` pairs, then a
 * trailing `\0`. */
export function encodeStartupMessage(params: Readonly<Record<string, string>>): Buffer {
  const w = new PgWriter();
  w.int32(PROTOCOL_VERSION_3_0);
  for (const [key, value] of Object.entries(params)) {
    w.cstring(key);
    w.cstring(value);
  }
  w.int8(0);
  const body = w.build();
  const header = Buffer.alloc(4);
  header.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([header, body], 4 + body.length);
}

/** The `SSLRequest` pseudo-message: a fixed 8-byte packet requesting TLS upgrade before startup. */
export function encodeSslRequest(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeInt32BE(SSL_REQUEST_CODE, 4);
  return buf;
}

/** Reads fields out of one message's body (the bytes after the type byte and length prefix). */
export class PgReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remainingLength(): number {
    return this.buf.length - this.offset;
  }

  get hasMore(): boolean {
    return this.offset < this.buf.length;
  }

  int8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  int16(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  int32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  cstring(): string {
    const idx = this.buf.indexOf(0, this.offset);
    if (idx === -1) throw new RangeError('unterminated C-string in PostgreSQL message');
    const s = this.buf.toString('utf8', this.offset, idx);
    this.offset = idx + 1;
    return s;
  }

  /** Reads `n` raw bytes as a fresh copy (safe to retain past the framer's next `push`). */
  bytes(n: number): Buffer {
    const b = Buffer.from(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return b;
  }

  /** Reads the rest of the message. */
  rest(): Buffer {
    return this.bytes(this.remainingLength);
  }
}

export interface BackendMessage {
  readonly type: string;
  readonly body: Buffer;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 256 * 1024 * 1024;

/**
 * Incrementally splits a backend byte stream into `BackendMessage`s. Bounded: a declared length
 * beyond `maxMessageLength` fails fast with {@link LimitExceededError} instead of buffering an
 * attacker- or bug-controlled amount of memory (SECURITY.md: "parsers are bounded").
 */
export class BackendMessageFramer {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH) {}

  push(chunk: Buffer): BackendMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const messages: BackendMessage[] = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const len = this.buf.readInt32BE(1);
      if (len < 4) {
        throw new RangeError(`PostgreSQL message declares an impossible length ${len}`);
      }
      if (len - 4 > this.maxMessageLength) {
        throw new LimitExceededError(
          'postgres.message.length',
          this.maxMessageLength,
          `backend message declares ${len - 4} byte(s) of payload, exceeding the ${this.maxMessageLength}-byte limit`,
        );
      }
      const total = 1 + len;
      if (this.buf.length < total) break;
      const type = String.fromCharCode(this.buf[0]!);
      const body = Buffer.from(this.buf.subarray(5, total));
      messages.push({ type, body });
      this.buf = this.buf.subarray(total);
    }
    return messages;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
