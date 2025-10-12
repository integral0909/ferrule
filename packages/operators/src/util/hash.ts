import { toHex, Timestamp, type Value } from '@ferrule/core';

/**
 * Stable hashing helpers shared by operators that need consistent bucketing (sampling,
 * dedupe fingerprints, cardinality tracking, bloom filters). Uses 64-bit FNV-1a, which is not
 * cryptographic but is fast, deterministic across runs, and has good distribution for the
 * short keys these operators hash.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** A second, independent offset for double-hashing (e.g. bloom filter indices). */
export const ALT_SEED = 0x9e3779b97f4a7c15n;

const encoder = new TextEncoder();

/** 64-bit FNV-1a over raw bytes. `seed` replaces the standard offset basis. */
export function fnv1a64(bytes: Uint8Array, seed: bigint = FNV_OFFSET_BASIS): bigint {
  let hash = seed & MASK64;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

export function hashString(text: string, seed?: bigint): bigint {
  return fnv1a64(encoder.encode(text), seed);
}

export function hashBytes(bytes: Uint8Array, seed?: bigint): bigint {
  return fnv1a64(bytes, seed);
}

/**
 * MurmurHash3's 64-bit finalizer. FNV-1a's own avalanche is weak (structured inputs like
 * sequential IDs or similar-prefix keys can land in visibly non-uniform bands), so callers that
 * need a *uniformly* distributed bucket — {@link unitInterval} — run the hash through this fixed
 * bit-mixing step first, which does not depend on the input beyond the hash itself.
 */
export function fmix64(input: bigint): bigint {
  let h = input & MASK64;
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & MASK64;
  h ^= h >> 33n;
  h = (h * 0xc4ceb9fe1a85ec53n) & MASK64;
  h ^= h >> 33n;
  return h;
}

/**
 * Maps a 64-bit hash uniformly into `[0, 1)`. Applies {@link fmix64} to compensate for FNV-1a's
 * weaker avalanche, then uses the top 48 bits so the result is exactly representable as a
 * float64 (a full 64-bit value would lose precision).
 */
export function unitInterval(hash: bigint): number {
  const mixed = fmix64(hash);
  const top48 = (mixed >> 16n) & 0xffffffffffffn;
  return Number(top48) / 0x1000000000000;
}

/**
 * A canonical, type-disambiguating string encoding of a {@link Value}, suitable for hashing or
 * as a cache key. Object keys are sorted so key order never affects the fingerprint; every kind
 * of value has a distinct tag so e.g. the integer `1`, the float `1.0`, and the string `"1"`
 * never collide.
 */
export function fingerprintValue(value: Value): string {
  if (value === null) return 'n';
  switch (typeof value) {
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'bigint':
      return `i${value.toString()}`;
    case 'number':
      return `f${value}`;
    case 'string':
      return `s${value.length}:${value}`;
    default:
      break;
  }
  if (value instanceof Timestamp) return `t${value.nanos.toString()}`;
  if (value instanceof Map) {
    const keys = [...value.keys()].sort();
    let out = `o${keys.length}`;
    for (const key of keys) out += `:${key.length}:${key}=${fingerprintValue(value.get(key)!)}`;
    return out;
  }
  if (Array.isArray(value)) {
    let out = `a${value.length}`;
    for (const item of value) out += `:${fingerprintValue(item)}`;
    return out;
  }
  return `x${toHex(value)}`;
}

/** Fingerprints an ordered list of `[path, value]` pairs (e.g. selected event fields). */
export function fingerprintFields(
  fields: readonly (readonly [string, Value | undefined])[],
): string {
  let out = `p${fields.length}`;
  for (const [path, value] of fields) {
    out += `:${path.length}:${path}=${value === undefined ? 'u' : fingerprintValue(value)}`;
  }
  return out;
}
