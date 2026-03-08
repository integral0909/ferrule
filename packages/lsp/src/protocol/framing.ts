/**
 * The LSP base protocol: messages are UTF-8-encoded JSON bodies prefixed with `Content-Length`/
 * `Content-Type` headers, separated from the body by a blank line (`\r\n\r\n`):
 *
 * ```
 * Content-Length: 38\r\n
 * \r\n
 * {"jsonrpc":"2.0","method":"foo"}
 * ```
 *
 * `Content-Length` counts *bytes* of the UTF-8-encoded body, not UTF-16 code units or characters
 * — a body containing multi-byte characters has a byte length larger than its JS string length.
 * {@link FrameDecoder} is a streaming, chunk-boundary-agnostic parser: it accepts arbitrarily
 * split `Buffer`/`Uint8Array`/`string` chunks (a header split mid-line, a body split mid-UTF-8-
 * sequence, several whole messages in one chunk) and always reproduces exactly the message
 * sequence that would result from parsing the unsplit stream.
 */

const HEADER_SEPARATOR = '\r\n\r\n';
const CONTENT_LENGTH = 'content-length';

/** Encodes a JSON-RPC message value as a framed wire buffer, ready to write to an output stream. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

type DecoderState = 'header' | 'body';

/**
 * Incrementally decodes a byte stream into a sequence of parsed JSON message values. Feed it
 * chunks in arrival order via {@link push}; each call returns every message that became complete
 * as a result of that chunk (usually zero or one, but possibly more if the chunk contained
 * several whole messages).
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private state: DecoderState = 'header';
  private contentLength = 0;

  /** Feeds a chunk of raw bytes (or text, encoded as UTF-8) and returns newly completed messages. */
  push(chunk: Buffer | Uint8Array | string): unknown[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.state === 'header') {
        if (!this.tryConsumeHeader()) break;
      }
      if (this.state === 'body') {
        const body = this.tryConsumeBody();
        if (body === undefined) break;
        messages.push(parseBody(body));
      }
    }
    return messages;
  }

  /** True if a partial message (header or body) is buffered but not yet complete. */
  get hasPendingData(): boolean {
    return this.buffer.length > 0;
  }

  private tryConsumeHeader(): boolean {
    const headerText = this.buffer.toString('ascii');
    const separatorIndex = headerText.indexOf(HEADER_SEPARATOR);
    if (separatorIndex === -1) return false;
    const rawHeaders = headerText.slice(0, separatorIndex);
    const length = parseContentLength(rawHeaders);
    this.contentLength = length;
    this.buffer = this.buffer.subarray(separatorIndex + HEADER_SEPARATOR.length);
    this.state = 'body';
    return true;
  }

  private tryConsumeBody(): Buffer | undefined {
    if (this.buffer.length < this.contentLength) return undefined;
    const body = this.buffer.subarray(0, this.contentLength);
    this.buffer = this.buffer.subarray(this.contentLength);
    this.state = 'header';
    return Buffer.from(body);
  }
}

function parseContentLength(rawHeaders: string): number {
  const lines = rawHeaders.split('\r\n').filter((line) => line.length > 0);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== CONTENT_LENGTH) continue;
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  throw new FramingError(
    `missing or invalid Content-Length header in: ${JSON.stringify(rawHeaders)}`,
  );
}

function parseBody(body: Buffer): unknown {
  const text = body.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new FramingError(`invalid JSON body: ${(cause as Error).message}`);
  }
}

/** Raised by {@link FrameDecoder} on a malformed header or body it cannot recover from. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}
