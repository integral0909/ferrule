import * as crypto from 'node:crypto';
import { parseScramAttributes, saltPassword } from '../../../src/stream/scram.js';

/**
 * A minimal, from-scratch SCRAM-SHA-256 *server*-side verifier, used only by fake servers in
 * tests (the fake PostgreSQL and Kafka brokers) to authenticate the real client implementation in
 * `src/stream/scram.ts` end-to-end, independently of that client's own code.
 */

export interface ScramServerSession {
  readonly clientFirstBare: string;
  readonly serverFirst: string;
  readonly salt: Buffer;
  readonly iterations: number;
  readonly combinedNonce: string;
}

export function scramServerFirst(clientFirstMessage: string): {
  response: string;
  session: ScramServerSession;
} {
  const bare = clientFirstMessage.startsWith('n,,')
    ? clientFirstMessage.slice(3)
    : clientFirstMessage;
  const attrs = parseScramAttributes(bare);
  const clientNonce = attrs['r']!;
  const serverNonceSuffix = crypto.randomBytes(18).toString('base64').replaceAll(/[+/=]/g, '');
  const combinedNonce = clientNonce + serverNonceSuffix;
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  const serverFirst = `r=${combinedNonce},s=${salt.toString('base64')},i=${iterations}`;
  return {
    response: serverFirst,
    session: { clientFirstBare: bare, serverFirst, salt, iterations, combinedNonce },
  };
}

export function scramServerVerifyFinal(
  session: ScramServerSession,
  password: string,
  clientFinalMessage: string,
): { ok: true; serverFinalMessage: string } | { ok: false } {
  const proofIdx = clientFinalMessage.lastIndexOf(',p=');
  const withoutProof = clientFinalMessage.slice(0, proofIdx);
  const proofB64 = clientFinalMessage.slice(proofIdx + 3);
  const saltedPassword = saltPassword(password, session.salt, session.iterations);
  const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const authMessage = `${session.clientFirstBare},${session.serverFirst},${withoutProof}`;
  const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
  const expectedProof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) expectedProof[i] = clientKey[i]! ^ clientSignature[i]!;
  if (expectedProof.toString('base64') !== proofB64) return { ok: false };
  const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest();
  const serverSignature = crypto.createHmac('sha256', serverKey).update(authMessage).digest();
  return { ok: true, serverFinalMessage: `v=${serverSignature.toString('base64')}` };
}
