/**
 * A minimal, dependency-free self-signed X.509 certificate generator, for TLS tests only (the
 * `http_server` and `syslog` TCP sources both support TLS). Node's `node:crypto` can generate
 * key pairs and sign arbitrary bytes but has no certificate-issuance API, so this hand-encodes
 * just enough DER (RFC 5280) to produce a certificate `tls`/`https` will accept: a v3
 * certificate with a real RSA key (whose SubjectPublicKeyInfo Node already gives us in DER,
 * saved re-encoding it by hand) and a self-signature over the TBSCertificate.
 *
 * Not a general-purpose ASN.1/X.509 library — just the fixed shape one self-signed test
 * certificate needs.
 */
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function seq(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function integer(value: number | Buffer): Buffer {
  let bytes = Buffer.isBuffer(value) ? Buffer.from(value) : encodeSmallInteger(value);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if ((bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function encodeSmallInteger(n: number): Buffer {
  if (n === 0) return Buffer.from([0]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(bytes);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    if (part === 0) {
      bytes.push(0);
      continue;
    }
    const chunk: number[] = [];
    let v = part;
    while (v > 0) {
      chunk.unshift(v & 0x7f);
      v >>= 7;
    }
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = chunk[i]! | 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function derNull(): Buffer {
  return tlv(0x05, Buffer.alloc(0));
}

function utf8String(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf8'));
}

function utcTime(date: Date): Buffer {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const text =
    `${p2(date.getUTCFullYear() % 100)}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}` +
    `${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function bitString(bytes: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
}

function explicitTag(tagNumber: number, content: Buffer): Buffer {
  return tlv(0xa0 | tagNumber, content);
}

const SHA256_WITH_RSA = seq(oid('1.2.840.113549.1.1.11'), derNull());
const COMMON_NAME_OID = '2.5.4.3';

function nameOf(commonName: string): Buffer {
  return seq(set(seq(oid(COMMON_NAME_OID), utf8String(commonName))));
}

function toPem(label: string, der: Buffer): string {
  const base64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface SelfSignedCert {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Generates a fresh, self-signed RSA certificate valid for `CN=<commonName>`. */
export function generateSelfSignedCert(commonName = 'localhost'): SelfSignedCert {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const subject = nameOf(commonName);

  const tbsCertificate = seq(
    explicitTag(0, integer(2)), // version: v3
    integer(randomBytes(8)), // serialNumber
    SHA256_WITH_RSA, // signature algorithm (repeated in TBS per RFC 5280)
    subject, // issuer (self-signed: issuer === subject)
    seq(utcTime(notBefore), utcTime(notAfter)), // validity
    subject, // subject
    publicKey, // subjectPublicKeyInfo, already complete DER from Node
  );

  const signature = cryptoSign('sha256', tbsCertificate, privateKey);
  const certificate = seq(tbsCertificate, SHA256_WITH_RSA, bitString(signature));

  return { certPem: toPem('CERTIFICATE', certificate), keyPem: privateKey };
}
