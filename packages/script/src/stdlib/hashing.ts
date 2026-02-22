import { toHex, utf8Encode } from '@ferrule/core';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import type { RuntimeValue } from '../runtime/context.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { bytesType, stringType, unionType } from '../types/types.js';
import { fn } from './helpers.js';

const stringOrBytesType = unionType([stringType, bytesType]);

/**
 * Hashing and IDs: `sha1`, `sha256`, `md5`, `hmac` (all via `node:crypto`), `uuid_v4`, `uuid_v7`
 * (`node:crypto`'s `randomUUID`/`randomBytes`).
 *
 * `md5`/`sha1` are cryptographically broken; they are provided for non-security uses such as
 * stable dedup keys/IDs derived from log content, not for anything security-sensitive.
 */
export function registerHashing(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerDigest(registry, impls, 'sha1', 'sha1');
  registerDigest(registry, impls, 'sha256', 'sha256');
  registerDigest(registry, impls, 'md5', 'md5');

  registry.register(
    fn(
      'hmac',
      [
        param('value', stringOrBytesType, { doc: 'the message to authenticate' }),
        param('key', stringOrBytesType, { doc: 'the HMAC key' }),
        param('algorithm', stringType, { optional: true, namedOnly: true, defaultDoc: '"sha256"' }),
      ],
      stringType,
      'always',
      true,
      'Computes an HMAC over `value` with `key`, returned as a lowercase hex digest. `algorithm` is one of `"sha1"`, `"sha256"`, `"sha512"`, `"md5"` (default `"sha256"`); fails for an unknown algorithm.',
      ['hmac(.payload, .secret)!', 'hmac(.payload, .secret, algorithm: "sha512")!'],
    ),
  );
  impls?.register(
    impl('hmac', (args) => {
      const value = args.positional[0] ?? null;
      const key = args.positional[1] ?? null;
      const valueBytes = toBytes(value);
      const keyBytes = toBytes(key);
      if (valueBytes === null) {
        return new Failure(`hmac requires a string or bytes value, found ${scriptKindOf(value)}`);
      }
      if (keyBytes === null) {
        return new Failure(`hmac requires a string or bytes key, found ${scriptKindOf(key)}`);
      }
      const algorithmArg = args.named.get('algorithm');
      const algorithm = typeof algorithmArg === 'string' ? algorithmArg : 'sha256';
      try {
        return createHmac(algorithm, keyBytes).update(valueBytes).digest('hex');
      } catch (error) {
        return new Failure(
          `hmac: unsupported algorithm ${JSON.stringify(algorithm)} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }),
  );

  registry.register(
    fn(
      'uuid_v4',
      [],
      stringType,
      'never',
      false,
      'Generates a random UUID (version 4, RFC 4122), e.g. `"f47ac10b-58cc-4372-a567-0e02b2c3d479"`.',
      ['uuid_v4()'],
    ),
  );
  impls?.register(impl('uuid_v4', () => randomUUID()));

  registry.register(
    fn(
      'uuid_v7',
      [],
      stringType,
      'never',
      false,
      'Generates a random, time-sortable UUID (version 7, RFC 9562): a 48-bit millisecond Unix timestamp followed by random bits, so UUIDs generated later sort later as plain strings.',
      ['uuid_v7()'],
    ),
  );
  impls?.register(impl('uuid_v7', () => uuidV7()));
}

function registerDigest(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
  name: string,
  algorithm: string,
): void {
  registry.register(
    fn(
      name,
      [param('value', stringOrBytesType, { doc: 'the string or bytes to hash' })],
      stringType,
      'on-argument-mismatch',
      true,
      `Returns the ${algorithm.toUpperCase()} digest of a string (hashed as UTF-8) or bytes, as lowercase hex. Not for security use — see \`hmac\` for authenticated hashing.`,
      [`${name}(.body)`],
    ),
  );
  impls?.register(
    impl(name, (args) => {
      const v = args.positional[0] ?? null;
      const bytes = toBytes(v);
      if (bytes === null) {
        return new Failure(`${name} requires a string or bytes, found ${scriptKindOf(v)}`);
      }
      return createHash(algorithm).update(bytes).digest('hex');
    }),
  );
}

/** Encodes a `string` (as UTF-8) or returns `Uint8Array` bytes as-is; `null` for anything else. */
function toBytes(v: RuntimeValue): Uint8Array | null {
  if (typeof v === 'string') return utf8Encode(v);
  if (v instanceof Uint8Array) return v;
  return null;
}

/**
 * Builds a UUID version 7 (RFC 9562 §5.7): a 48-bit big-endian millisecond Unix timestamp, a
 * 4-bit version (`0111`), 12 random bits, a 2-bit variant (`10`), and 62 more random bits.
 */
function uuidV7(): string {
  const bytes = new Uint8Array(16);
  const millis = BigInt(Date.now());
  bytes[0] = Number((millis >> 40n) & 0xffn);
  bytes[1] = Number((millis >> 32n) & 0xffn);
  bytes[2] = Number((millis >> 24n) & 0xffn);
  bytes[3] = Number((millis >> 16n) & 0xffn);
  bytes[4] = Number((millis >> 8n) & 0xffn);
  bytes[5] = Number(millis & 0xffn);

  const rand = randomBytes(10);
  bytes[6] = 0x70 | (rand[0]! & 0x0f); // version 7
  bytes[7] = rand[1]!;
  bytes[8] = 0x80 | (rand[2]! & 0x3f); // variant 10
  bytes[9] = rand[3]!;
  bytes[10] = rand[4]!;
  bytes[11] = rand[5]!;
  bytes[12] = rand[6]!;
  bytes[13] = rand[7]!;
  bytes[14] = rand[8]!;
  bytes[15] = rand[9]!;

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
