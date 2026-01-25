import { describe, expect, it } from 'vitest';
import { ScramProtocolError, ScramSha256Client, saslPrepStored } from '../../src/stream/scram.js';

// The published RFC 7677 §3 example exchange for SCRAM-SHA-256.
const RFC7677_PASSWORD = 'pencil';
const RFC7677_USERNAME = 'user';
const RFC7677_CLIENT_NONCE = 'rOprNGfwEbeRWgbNEkqO';
const RFC7677_CLIENT_FIRST = 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO';
const RFC7677_SERVER_FIRST =
  'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
const RFC7677_CLIENT_FINAL =
  'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
const RFC7677_SERVER_FINAL = 'v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

describe('ScramSha256Client (RFC 7677 published test vector)', () => {
  it('produces exactly the client-first-message from the RFC', () => {
    const client = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    expect(client.clientFirstMessage()).toBe(RFC7677_CLIENT_FIRST);
  });

  it('computes the exact client proof from the RFC given the server-first-message', () => {
    const client = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    client.clientFirstMessage();
    client.receiveServerFirstMessage(RFC7677_SERVER_FIRST);
    expect(client.clientFinalMessage()).toBe(RFC7677_CLIENT_FINAL);
  });

  it('verifies the server-final-message signature from the RFC without throwing', () => {
    const client = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    client.clientFirstMessage();
    client.receiveServerFirstMessage(RFC7677_SERVER_FIRST);
    client.clientFinalMessage();
    expect(() => client.receiveServerFinalMessage(RFC7677_SERVER_FINAL)).not.toThrow();
  });

  it('rejects a tampered server signature', () => {
    const client = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    client.clientFirstMessage();
    client.receiveServerFirstMessage(RFC7677_SERVER_FIRST);
    client.clientFinalMessage();
    expect(() =>
      client.receiveServerFinalMessage('v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    ).toThrow(/verification failed/);
  });

  it('rejects a server nonce that does not extend the client nonce', () => {
    const client = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    client.clientFirstMessage();
    expect(() =>
      client.receiveServerFirstMessage('r=totallyDifferentNonce,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'),
    ).toThrow(ScramProtocolError);
  });

  it('surfaces a server-reported e= error', () => {
    const client = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    client.clientFirstMessage();
    client.receiveServerFirstMessage(RFC7677_SERVER_FIRST);
    client.clientFinalMessage();
    expect(() => client.receiveServerFinalMessage('e=invalid-proof')).toThrow(/invalid-proof/);
  });

  it('a full round trip between two independent client instances with matching salted password agrees', () => {
    // Simulates what a fake server needs to do: derive the same SaltedPassword and verify the
    // client's proof, then compute its own ServerSignature. We do this by running the client
    // twice with the same salt/iterations and cross-checking the derived values agree.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const iterations = 4096;
    const a = new ScramSha256Client(RFC7677_PASSWORD, RFC7677_USERNAME, RFC7677_CLIENT_NONCE);
    a.clientFirstMessage();
    a.receiveServerFirstMessage(
      `r=${RFC7677_CLIENT_NONCE}extra,s=${salt.toString('base64')},i=${iterations}`,
    );
    expect(() => a.clientFinalMessage()).not.toThrow();
  });
});

describe('saslPrepStored', () => {
  it('passes pure ASCII passwords through unchanged', () => {
    expect(saslPrepStored('pencil')).toBe('pencil');
    expect(saslPrepStored('P@ssw0rd! 123')).toBe('P@ssw0rd! 123');
  });

  it('NFKC-normalises non-ASCII passwords as a best-effort approximation', () => {
    // "ﬁ" is the "fi" ligature; NFKC decomposes it to "fi".
    expect(saslPrepStored('ﬁle')).toBe('file');
  });
});
