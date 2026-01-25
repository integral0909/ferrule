import * as crypto from 'node:crypto';
import { ScramSha256Client } from '../stream/scram.js';
import { PostgresAuthError } from './errors.js';

/** Authentication sub-protocol request codes from `AuthenticationXXX` (`R`) backend messages. */
export const AuthCode = {
  Ok: 0,
  KerberosV5: 2,
  CleartextPassword: 3,
  MD5Password: 5,
  SCM: 6,
  GSS: 7,
  GSSContinue: 8,
  SSPI: 9,
  SASL: 10,
  SASLContinue: 11,
  SASLFinal: 12,
} as const;

/** `md5` + hex(MD5(password + username))`, then `"md5" + hex(MD5(that + salt))`, per PostgreSQL's
 * `AuthenticationMD5Password` scheme (protocol docs, §55.3). */
export function computeMd5PasswordResponse(
  username: string,
  password: string,
  salt: Buffer,
): string {
  const inner = crypto
    .createHash('md5')
    .update(password, 'utf8')
    .update(username, 'utf8')
    .digest('hex');
  const outer = crypto.createHash('md5').update(inner, 'utf8').update(salt).digest('hex');
  return `md5${outer}`;
}

export const SCRAM_SHA_256_MECHANISM = 'SCRAM-SHA-256';

/** Picks a supported mechanism from the server's `AuthenticationSASL` list. Only SCRAM-SHA-256 is
 * implemented; `SCRAM-SHA-256-PLUS` (channel binding) is not offered since this client never
 * negotiates TLS channel binding. */
export function chooseSaslMechanism(offered: readonly string[]): string {
  if (offered.includes(SCRAM_SHA_256_MECHANISM)) return SCRAM_SHA_256_MECHANISM;
  throw new PostgresAuthError(
    `server did not offer a supported SASL mechanism (offered: ${offered.join(', ') || '(none)'})`,
  );
}

/**
 * Drives a PostgreSQL SASL/SCRAM-SHA-256 exchange on top of the shared {@link ScramSha256Client}.
 * PostgreSQL's SCRAM implementation ignores the `n=` identity in the SCRAM messages (the startup
 * packet's user is authoritative), so this always sends an empty username, matching libpq.
 */
export class PostgresScramAuth {
  private readonly client: ScramSha256Client;

  constructor(password: string) {
    this.client = new ScramSha256Client(password, '');
  }

  /** The `SASLInitialResponse` payload: `client-first-message`, UTF-8 encoded. */
  initialResponse(): Buffer {
    return Buffer.from(this.client.clientFirstMessage(), 'utf8');
  }

  /** Processes the `AuthenticationSASLContinue` payload and returns the `SASLResponse` payload
   * (`client-final-message`) to send back. */
  continueResponse(serverFirstMessage: Buffer): Buffer {
    this.client.receiveServerFirstMessage(serverFirstMessage.toString('utf8'));
    return Buffer.from(this.client.clientFinalMessage(), 'utf8');
  }

  /** Verifies the `AuthenticationSASLFinal` payload. Throws on a bad server signature. */
  finish(serverFinalMessage: Buffer): void {
    this.client.receiveServerFinalMessage(serverFinalMessage.toString('utf8'));
  }
}

/** Splits the null-separated, doubly-null-terminated mechanism list in an `AuthenticationSASL`
 * message body (after the leading `Int32(10)` request code has already been consumed). */
export function parseSaslMechanismList(buf: Buffer): string[] {
  const mechanisms: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i === start) break; // the terminating empty string
      mechanisms.push(buf.toString('utf8', start, i));
      start = i + 1;
    }
  }
  return mechanisms;
}
