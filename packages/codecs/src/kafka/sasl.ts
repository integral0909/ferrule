import { ScramSha256Client } from '../scram.js';
import type { KafkaBrokerConnection } from './connection.js';
import { KafkaAuthError } from './errors.js';
import {
  ApiKey,
  decodeSaslAuthenticateResponseV1,
  decodeSaslHandshakeResponseV1,
  encodeSaslAuthenticateRequestV1,
  encodeSaslHandshakeRequestV1,
} from './protocol.js';

/** SASL/PLAIN and SASL/SCRAM-SHA-256, the two mechanisms this client implements. SCRAM reuses
 * this package's own `../scram.js` client (also used by `@ferrule/sinks`'s PostgreSQL sink). */
export interface KafkaSaslOptions {
  readonly mechanism: 'PLAIN' | 'SCRAM-SHA-256';
  readonly username: string;
  readonly password: string;
}

async function authenticate(conn: KafkaBrokerConnection, authBytes: Buffer): Promise<Buffer> {
  const body = await conn.sendRequest(
    ApiKey.SaslAuthenticate,
    1,
    false,
    encodeSaslAuthenticateRequestV1(authBytes),
  );
  const response = decodeSaslAuthenticateResponseV1(body);
  if (response.errorCode !== 0) {
    throw new KafkaAuthError(
      response.errorMessage ?? `SASL authentication failed (error code ${response.errorCode})`,
    );
  }
  return response.authBytes;
}

/** Runs the SASL handshake and authentication exchange on an already-connected
 * {@link KafkaBrokerConnection}, before it is used for any other request. */
export async function performSaslAuth(
  conn: KafkaBrokerConnection,
  sasl: KafkaSaslOptions,
): Promise<void> {
  const handshakeBody = await conn.sendRequest(
    ApiKey.SaslHandshake,
    1,
    false,
    encodeSaslHandshakeRequestV1(sasl.mechanism),
  );
  const handshake = decodeSaslHandshakeResponseV1(handshakeBody);
  if (handshake.errorCode !== 0) {
    throw new KafkaAuthError(
      `broker rejected SASL mechanism ${sasl.mechanism} (offers: ${handshake.mechanisms.join(', ') || '(none)'})`,
    );
  }

  if (sasl.mechanism === 'PLAIN') {
    // RFC 4616: [authzid] UTF8NUL authcid UTF8NUL passwd.
    const authBytes = Buffer.from(`\0${sasl.username}\0${sasl.password}`, 'utf8');
    await authenticate(conn, authBytes);
    return;
  }

  const scram = new ScramSha256Client(sasl.password, sasl.username);
  const serverFirst = await authenticate(conn, Buffer.from(scram.clientFirstMessage(), 'utf8'));
  scram.receiveServerFirstMessage(serverFirst.toString('utf8'));
  const serverFinal = await authenticate(conn, Buffer.from(scram.clientFinalMessage(), 'utf8'));
  scram.receiveServerFinalMessage(serverFinal.toString('utf8'));
}
