import * as crypto from 'node:crypto';

/**
 * A client-side implementation of SCRAM-SHA-256 (RFC 5802 "SCRAM", RFC 7677 "SCRAM-SHA-256"),
 * shared by the PostgreSQL wire protocol client (`@ferrule/sinks`'s `postgres/`) and the Kafka
 * SASL/SCRAM client (`./kafka/sasl.ts`, in this package) so the mechanism is implemented exactly
 * once. It lives here rather than in either sink-specific package because it is itself a generic
 * SASL mechanism, not tied to either wire protocol — the same reasoning that puts murmur2 and
 * RecordBatch decoding in this package's `kafka/` directory.
 *
 * Password preparation is SASLprep (RFC 4013) only for the common case that matters in practice:
 * passwords that are pure ASCII pass through unchanged (which is what SASLprep does to them,
 * since ASCII has no case-folding, bidi, or "mapped to nothing" characters to worry about). A
 * password containing non-ASCII characters is Unicode-normalised (NFKC) as a best-effort
 * approximation of the full stringprep profile; the prohibited-character and bidirectional checks
 * RFC 4013 also requires are not implemented, so full RFC correctness is only guaranteed for
 * ASCII-safe passwords, per this module's scope.
 */

const GS2_HEADER_NO_CHANNEL_BINDING = 'n,,';
/** base64("n,,"), the channel-binding attribute clients that do not support it always send. */
const CBIND_INPUT_B64 = Buffer.from(GS2_HEADER_NO_CHANNEL_BINDING, 'utf8').toString('base64');

export function saslPrepStored(password: string): string {
  if (/^[\x20-\x7e]*$/.test(password)) return password;
  return password.normalize('NFKC');
}

/** Generates a client nonce: base64url-safe-ish printable ASCII, no comma (SCRAM's field
 * separator) and no `=` (which would be ambiguous with attribute syntax if it appeared mid-value,
 * even though it is technically allowed — printable, comma-free base64 keeps things simple). */
export function generateClientNonce(bytes = 24): string {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replaceAll(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

function hmacSha256(key: Uint8Array, data: string): Buffer {
  return crypto.createHmac('sha256', Buffer.from(key)).update(data, 'utf8').digest();
}

function sha256(data: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(Buffer.from(data)).digest();
}

function xorBytes(a: Uint8Array, b: Uint8Array): Buffer {
  if (a.length !== b.length) throw new RangeError('XOR operands must be the same length');
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** Derives SaltedPassword via PBKDF2-HMAC-SHA256 (`Hi()` in RFC 5802 terms). */
export function saltPassword(password: string, salt: Uint8Array, iterations: number): Buffer {
  return crypto.pbkdf2Sync(saslPrepStored(password), Buffer.from(salt), iterations, 32, 'sha256');
}

/** Parses a comma-separated `key=value` attribute list (a SCRAM server message). */
export function parseScramAttributes(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export class ScramProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScramProtocolError';
  }
}

/**
 * Drives one SCRAM-SHA-256 exchange as the client. Usage:
 *
 * ```ts
 * const scram = new ScramSha256Client(password);
 * send(scram.clientFirstMessage());
 * scram.receiveServerFirstMessage(await recv());
 * send(scram.clientFinalMessage());
 * scram.receiveServerFinalMessage(await recv()); // throws if the server proof doesn't verify
 * ```
 */
export class ScramSha256Client {
  private readonly clientNonce: string;
  private readonly clientFirstMessageBare: string;
  private serverFirstMessage: string | undefined;
  private combinedNonce: string | undefined;
  private saltedPassword: Buffer | undefined;
  private authMessage: string | undefined;

  /**
   * @param username The SCRAM `n=` identity. PostgreSQL ignores it (the startup packet's user is
   * authoritative) and libpq sends an empty string, which is this constructor's default; pass an
   * explicit value where the mechanism's peer does check it (e.g. some Kafka SASL/SCRAM servers).
   */
  constructor(
    private readonly password: string,
    username = '',
    clientNonce: string = generateClientNonce(),
  ) {
    this.clientNonce = clientNonce;
    this.clientFirstMessageBare = `n=${escapeScramName(username)},r=${this.clientNonce}`;
  }

  /** The GS2 header plus `client-first-message-bare`; send this first. */
  clientFirstMessage(): string {
    return `${GS2_HEADER_NO_CHANNEL_BINDING}${this.clientFirstMessageBare}`;
  }

  /** Processes `r=<nonce>,s=<salt>,i=<iterations>` from the server. */
  receiveServerFirstMessage(message: string): void {
    const attrs = parseScramAttributes(message);
    const nonce = attrs['r'];
    const saltB64 = attrs['s'];
    const iterationsStr = attrs['i'];
    if (nonce === undefined || saltB64 === undefined || iterationsStr === undefined) {
      throw new ScramProtocolError(`malformed SCRAM server-first-message: ${message}`);
    }
    if (!nonce.startsWith(this.clientNonce)) {
      throw new ScramProtocolError('server nonce does not extend the client nonce');
    }
    const iterations = Number(iterationsStr);
    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw new ScramProtocolError(`invalid SCRAM iteration count: ${iterationsStr}`);
    }
    this.serverFirstMessage = message;
    this.combinedNonce = nonce;
    const salt = Buffer.from(saltB64, 'base64');
    this.saltedPassword = saltPassword(this.password, salt, iterations);
  }

  /** Computes `c=biws,r=<nonce>,p=<proof>`; send this second. */
  clientFinalMessage(): string {
    if (this.saltedPassword === undefined || this.combinedNonce === undefined) {
      throw new ScramProtocolError(
        'clientFinalMessage() called before receiveServerFirstMessage()',
      );
    }
    const clientKey = hmacSha256(this.saltedPassword, 'Client Key');
    const storedKey = sha256(clientKey);
    const clientFinalMessageWithoutProof = `c=${CBIND_INPUT_B64},r=${this.combinedNonce}`;
    this.authMessage = [
      this.clientFirstMessageBare,
      this.serverFirstMessage,
      clientFinalMessageWithoutProof,
    ].join(',');
    const clientSignature = hmacSha256(storedKey, this.authMessage);
    const clientProof = xorBytes(clientKey, clientSignature);
    return `${clientFinalMessageWithoutProof},p=${clientProof.toString('base64')}`;
  }

  /** Verifies `v=<signature>` from the server. Throws if it is missing, an `e=` error, or does
   * not match the expected server signature (which would indicate a MITM or a wrong password). */
  receiveServerFinalMessage(message: string): void {
    if (this.saltedPassword === undefined || this.authMessage === undefined) {
      throw new ScramProtocolError(
        'receiveServerFinalMessage() called before clientFinalMessage()',
      );
    }
    const attrs = parseScramAttributes(message);
    if (attrs['e'] !== undefined) {
      throw new ScramProtocolError(`server reported a SCRAM error: ${attrs['e']}`);
    }
    const v = attrs['v'];
    if (v === undefined) {
      throw new ScramProtocolError(`malformed SCRAM server-final-message: ${message}`);
    }
    const serverKey = hmacSha256(this.saltedPassword, 'Server Key');
    const serverSignature = hmacSha256(serverKey, this.authMessage);
    if (serverSignature.toString('base64') !== v) {
      throw new ScramProtocolError('server SCRAM signature verification failed');
    }
  }
}

/** Escapes `=` and `,` in a SCRAM name (`n=`/`a=` values) per RFC 5802 §5.1 (`=3D` / `=2C`). */
function escapeScramName(name: string): string {
  return name.replaceAll('=', '=3D').replaceAll(',', '=2C');
}
