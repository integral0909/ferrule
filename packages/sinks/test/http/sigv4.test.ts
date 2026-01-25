import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deriveSigningKey,
  EMPTY_PAYLOAD_SHA256,
  sha256Hex,
  signV4,
  uriEncodeComponent,
  uriEncodePath,
} from '../../src/http/sigv4.js';

// The "AWS documented SigV4 example" tests check the published values from the AWS docs. The
// remaining examples compare against expected values computed directly with Node's `crypto`
// primitives following the documented algorithm, and check invariants of the canonical forms.

// Published worked example from the AWS Signature Version 4 documentation: an IAM ListUsers
// request signed on 2015-08-30 with the documentation's example credentials. These values come
// from the AWS docs, not from this implementation.
describe('AWS documented SigV4 example (IAM ListUsers)', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

  it('derives the documented signing key', () => {
    expect(deriveSigningKey(secret, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  it('produces the documented signature', () => {
    const result = signV4({
      method: 'GET',
      canonicalUri: '/',
      queryParams: [
        ['Action', 'ListUsers'],
        ['Version', '2010-05-08'],
      ],
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        Host: 'iam.amazonaws.com',
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: 'us-east-1',
      service: 'iam',
      date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: secret },
      contentSha256Header: false,
    });
    expect(result.signedHeaders).toBe('content-type;host;x-amz-date');
    expect(result.signature).toBe(
      '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });
});

describe('SHA-256 of the empty string', () => {
  it('matches the well-known constant', () => {
    expect(sha256Hex('')).toBe(EMPTY_PAYLOAD_SHA256);
    expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY_PAYLOAD_SHA256);
  });
});

describe('deriveSigningKey', () => {
  it('is stable for a fixed secret, date, region, and service', () => {
    const key = deriveSigningKey(
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '20150830',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      '2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c'.slice(0, 64),
    );
  });
});

describe('signV4 — S3 "GET Object" worked example', () => {
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const date = new Date('2013-05-24T00:00:00Z');

  it('produces the documented canonical request, string to sign, and signature', () => {
    const result = signV4({
      method: 'GET',
      canonicalUri: '/test.txt',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: 'us-east-1',
      service: 's3',
      date,
      credentials,
    });

    expect(result.amzDate).toBe('20130524T000000Z');
    expect(result.credentialScope).toBe('20130524/us-east-1/s3/aws4_request');
    expect(result.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date');
    expect(result.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_PAYLOAD_SHA256,
      ].join('\n'),
    );
    expect(result.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20130524T000000Z',
        '20130524/us-east-1/s3/aws4_request',
        sha256Hex(result.canonicalRequest),
      ].join('\n'),
    );
    // Computed independently via crypto.createHmac following the same documented chain.
    expect(result.signature).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(result.authorizationHeader).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('includes x-amz-security-token when a session token is given, both in headers and signing', () => {
    const result = signV4({
      method: 'PUT',
      canonicalUri: '/bucket/key',
      headers: { host: 'example.com' },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: 'us-east-1',
      service: 's3',
      date,
      credentials: { ...credentials, sessionToken: 'the-session-token' },
    });
    expect(result.headers['x-amz-security-token']).toBe('the-session-token');
    expect(result.signedHeaders).toContain('x-amz-security-token');
    expect(result.canonicalRequest).toContain('x-amz-security-token:the-session-token');
  });
});

describe('signV4 — invariants', () => {
  it('changing the payload hash changes the signature (property)', () => {
    const hex32 = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((b) => Buffer.from(b).toString('hex'));
    fc.assert(
      fc.property(hex32, hex32, (a, b) => {
        fc.pre(a !== b);
        const base = {
          method: 'PUT',
          canonicalUri: '/x',
          headers: { host: 'example.com' },
          region: 'us-east-1',
          service: 's3',
          date: new Date('2020-01-01T00:00:00Z'),
          credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
        } as const;
        const s1 = signV4({ ...base, payloadHash: a });
        const s2 = signV4({ ...base, payloadHash: b });
        expect(s1.signature).not.toBe(s2.signature);
      }),
    );
  });

  it('is deterministic for identical input', () => {
    fc.assert(
      fc.property(fc.webPath(), fc.string(), (path, value) => {
        const input = {
          method: 'POST',
          canonicalUri: uriEncodePath(path === '' ? '/' : path),
          queryParams: [['q', value]] as const,
          headers: { host: 'example.com' },
          payloadHash: EMPTY_PAYLOAD_SHA256,
          region: 'eu-west-1',
          service: 'execute-api',
          date: new Date('2021-06-15T12:00:00Z'),
          credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
        };
        expect(signV4(input).signature).toBe(signV4(input).signature);
      }),
    );
  });
});

describe('uriEncodeComponent / uriEncodePath', () => {
  it('leaves unreserved characters untouched and percent-encodes everything else with uppercase hex', () => {
    expect(uriEncodeComponent('abcABC012-._~')).toBe('abcABC012-._~');
    expect(uriEncodeComponent(' ')).toBe('%20');
    expect(uriEncodeComponent('/')).toBe('%2F');
    expect(uriEncodeComponent('é')).toBe('%C3%A9');
  });

  it('uriEncodePath preserves "/" as a separator but encodes it nowhere else', () => {
    expect(uriEncodePath('/a b/c')).toBe('/a%20b/c');
  });

  it('never produces lowercase hex digits (property)', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const encoded = uriEncodeComponent(value);
        const hexPairs = encoded.match(/%[0-9A-Fa-f]{2}/g) ?? [];
        for (const pair of hexPairs) expect(pair).toBe(pair.toUpperCase());
      }),
    );
  });
});
