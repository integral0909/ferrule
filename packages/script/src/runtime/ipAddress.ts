/**
 * Minimal IPv4/IPv6 parsing and formatting for `redact_ip` (`stdlib/redact.ts`). Not a general-
 * purpose IP library: IPv6's embedded-IPv4 tail form (`::ffff:192.0.2.1`) is not supported (a
 * documented gap — see `stdlib/redact.ts`'s `redact_ip` docs), and neither form does zone-ID
 * (`%eth0`) parsing.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parses dotted-quad IPv4 text into 4 bytes, or `undefined` if it isn't valid IPv4. */
export function parseIPv4(text: string): Uint8Array | undefined {
  const m = IPV4.exec(text);
  if (m === null) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1]!;
    // Reject leading zeros ("01") and out-of-range octets; a bare "0" is fine.
    if (part.length > 1 && part.startsWith('0')) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    bytes[i] = n;
  }
  return bytes;
}

export function formatIPv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/**
 * Parses IPv6 text (full or `::`-compressed hextet form) into 16 bytes, or `undefined` if it
 * isn't valid IPv6. Does not support an embedded IPv4 tail (`::ffff:192.0.2.1`) or a zone ID.
 */
export function parseIPv6(text: string): Uint8Array | undefined {
  if (text.length === 0 || text.includes('.')) return undefined;
  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return undefined;

  let left: string[];
  let right: string[];
  if (text.includes('::')) {
    const [l, r] = text.split('::', 2) as [string, string];
    left = l === '' ? [] : l.split(':');
    right = r === '' ? [] : r.split(':');
  } else {
    left = text.split(':');
    right = [];
  }
  if (left.length + right.length > 8) return undefined;
  if (!doubleColonCount && left.length !== 8) return undefined;

  const middle = new Array<string>(8 - left.length - right.length).fill('0');
  const groups = [...left, ...middle, ...right];
  if (groups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    const n = Number.parseInt(g, 16);
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

/** Formats 16 bytes as IPv6 text, compressing the longest run of zero groups with `::`. */
export function formatIPv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const head = groups.slice(0, bestStart).map((g) => g.toString(16));
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
  return `${head.join(':')}::${tail.join(':')}`;
}

/** Zeros every bit beyond `keepBits` in a fixed-width address, left to right. */
function zeroBeyondPrefix(bytes: Uint8Array, keepBits: number): Uint8Array {
  const out = bytes.slice();
  for (let bit = keepBits; bit < out.length * 8; bit++) {
    const byteIndex = bit >> 3;
    const bitInByte = 7 - (bit & 7);
    out[byteIndex]! &= ~(1 << bitInByte);
  }
  return out;
}

export type RedactIpResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string };

/** Redacts an IPv4 or IPv6 address, zeroing address bits beyond `keepPrefixBits`. */
export function redactIpAddress(value: string, keepPrefixBits: number): RedactIpResult {
  const v4 = parseIPv4(value);
  if (v4 !== undefined) {
    if (keepPrefixBits < 0 || keepPrefixBits > 32) {
      return {
        ok: false,
        message: `keep_prefix must be 0-32 for an IPv4 address, found ${keepPrefixBits}`,
      };
    }
    return { ok: true, value: formatIPv4(zeroBeyondPrefix(v4, keepPrefixBits)) };
  }
  const v6 = parseIPv6(value);
  if (v6 !== undefined) {
    if (keepPrefixBits < 0 || keepPrefixBits > 128) {
      return {
        ok: false,
        message: `keep_prefix must be 0-128 for an IPv6 address, found ${keepPrefixBits}`,
      };
    }
    return { ok: true, value: formatIPv6(zeroBeyondPrefix(v6, keepPrefixBits)) };
  }
  return { ok: false, message: `${JSON.stringify(value)} is not a valid IPv4 or IPv6 address` };
}
