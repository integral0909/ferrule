import { createHash, createHmac } from 'node:crypto';

/**
 * A hand-written implementation of AWS Signature Version 4 request signing (header-based, not
 * the query-string/presigned variant), used by the `object_storage` sink. Follows the algorithm
 * documented at
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-calculate-signature.html: build a
 * canonical request, hash it, build a string to sign, derive a signing key by a chain of four
 * HMAC-SHA256 calls, and HMAC the string to sign with that key.
 *
 * Callers are responsible for URI-encoding the path and query themselves before calling
 * {@link signV4} (see {@link uriEncodePath}/{@link uriEncodeComponent}) so that the exact same
 * encoded string is both signed and sent — SigV4 requires byte-for-byte agreement between what
 * was signed and what is transmitted.
 */

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For temporary (STS) credentials; sent as `x-amz-security-token` and included in signing. */
  readonly sessionToken?: string;
}

export interface SigV4SignInput {
  readonly method: string;
  /** The already URI-encoded absolute path, e.g. `/bucket/key%20name`, per {@link uriEncodePath}. */
  readonly canonicalUri: string;
  /** Raw (not yet encoded) query parameters; encoded and sorted here. */
  readonly queryParams?: readonly (readonly [string, string])[];
  /** Extra headers to sign beyond what this function adds itself (must include `host`). */
  readonly headers: Readonly<Record<string, string>>;
  /** Lowercase hex SHA-256 of the request body, or the literal `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly date: Date;
  readonly credentials: SigV4Credentials;
  /**
   * Whether to add and sign `x-amz-content-sha256`. S3 requires it; most other services do not
   * use it. Default true.
   */
  readonly contentSha256Header?: boolean;
}

export interface SigV4SignResult {
  readonly authorizationHeader: string;
  readonly amzDate: string;
  readonly credentialScope: string;
  readonly signedHeaders: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
  /** `input.headers` plus `x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token` (if a
   * session token was given), and `authorization` — ready to send as-is. */
  readonly headers: Readonly<Record<string, string>>;
}

/** SHA-256 of the empty string — the `x-amz-content-sha256` value for a request with no body. */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** `HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")`. */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export function signV4(input: SigV4SignInput): SigV4SignResult {
  const amzDate = toAmzDate(input.date);
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers['x-amz-date'] = amzDate;
  if (input.contentSha256Header !== false) headers['x-amz-content-sha256'] = input.payloadHash;
  if (input.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${normalizeHeaderValue(headers[name]!)}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalQueryString = buildCanonicalQuery(input.queryParams ?? []);

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmacHex(signingKey, stringToSign);

  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers['authorization'] = authorizationHeader;

  return {
    authorizationHeader,
    amzDate,
    credentialScope,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
    headers,
  };
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function buildCanonicalQuery(params: readonly (readonly [string, string])[]): string {
  const encoded = params.map(([k, v]) => [uriEncodeComponent(k), uriEncodeComponent(v)] as const);
  encoded.sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1;
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return encoded.map(([k, v]) => `${k}=${v}`).join('&');
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

function encodeBytes(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** URI-encodes a single path segment or query component: every byte except the SigV4 unreserved
 * set (`A-Za-z0-9-._~`) is percent-encoded, with uppercase hex digits. */
export function uriEncodeComponent(value: string): string {
  return encodeBytes(value);
}

/** URI-encodes an absolute path for use as SigV4's `CanonicalURI`: each `/`-separated segment is
 * encoded with {@link uriEncodeComponent}; the separators themselves are left alone. */
export function uriEncodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeBytes(segment))
    .join('/');
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
