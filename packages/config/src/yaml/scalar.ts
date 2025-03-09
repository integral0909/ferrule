/**
 * YAML 1.2 core schema scalar resolution: deciding what a plain (unquoted) scalar's text means.
 *
 * Only the core schema is implemented, not the deprecated YAML 1.1 schema, so `no`, `yes`, `on`,
 * and `off` are ordinary strings (the "Norway problem": YAML 1.1 treated them as booleans, which
 * broke real configs using ISO 3166 country codes and other two-letter tokens).
 */

export type ScalarValue = string | number | bigint | boolean | null;

export type ScalarResolution = { ok: true; value: ScalarValue } | { ok: false; message: string };

export type ExplicitTag = 'str' | 'int' | 'float' | 'bool' | 'null';

const NULL_RE = /^(?:~|null|Null|NULL)$/;
const TRUE_RE = /^(?:true|True|TRUE)$/;
const FALSE_RE = /^(?:false|False|FALSE)$/;
const INT_DEC_RE = /^[-+]?(?:0|[1-9][0-9]*)$/;
const INT_HEX_RE = /^[-+]?0x[0-9a-fA-F]+$/;
const INT_OCT_RE = /^[-+]?0o[0-7]+$/;
// A float must have a decimal point or an exponent (otherwise it is indistinguishable from an
// integer, and integer resolution already ran first); a bare digit string like "0123" is neither
// a valid core-schema int (leading zero) nor a float, and stays a string.
const FLOAT_RE =
  /^[-+]?(?:[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?|\.[0-9]+(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+)$/;
const FLOAT_INF_RE = /^([-+]?)\.(?:inf|Inf|INF)$/;
const FLOAT_NAN_RE = /^\.(?:nan|NaN|NAN)$/;

/** The maximum magnitude an integer can have before it is represented as a `bigint`. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** Parses an integer literal (decimal, `0x` hex, or `0o` octal), or returns `undefined`. */
export function tryParseInt(text: string): number | bigint | undefined {
  let big: bigint;
  if (INT_DEC_RE.test(text)) {
    big = BigInt(text);
  } else if (INT_HEX_RE.test(text) || INT_OCT_RE.test(text)) {
    const negative = text.startsWith('-');
    const unsigned = text.replace(/^[-+]/, '');
    big = BigInt(unsigned);
    if (negative) big = -big;
  } else {
    return undefined;
  }
  return big >= MIN_SAFE && big <= MAX_SAFE ? Number(big) : big;
}

/** Parses a float literal, including `.inf`/`-.inf`/`.nan`, or returns `undefined`. */
export function tryParseFloat(text: string): number | undefined {
  const inf = FLOAT_INF_RE.exec(text);
  if (inf !== null) return inf[1] === '-' ? -Infinity : Infinity;
  if (FLOAT_NAN_RE.test(text)) return NaN;
  if (FLOAT_RE.test(text)) return Number(text);
  return undefined;
}

/** Resolves a plain scalar's text using the YAML 1.2 core schema. Quoted scalars skip this. */
export function resolveCoreScalar(text: string): ScalarValue {
  if (text === '' || NULL_RE.test(text)) return null;
  if (TRUE_RE.test(text)) return true;
  if (FALSE_RE.test(text)) return false;
  const int = tryParseInt(text);
  if (int !== undefined) return int;
  const float = tryParseFloat(text);
  if (float !== undefined) return float;
  return text;
}

/** Resolves a scalar's text under an explicit `!!` tag, which overrides plain-scalar guessing. */
export function resolveExplicitTag(tag: ExplicitTag, text: string): ScalarResolution {
  switch (tag) {
    case 'str':
      return { ok: true, value: text };
    case 'null':
      if (text === '' || NULL_RE.test(text)) return { ok: true, value: null };
      return { ok: false, message: `invalid !!null value ${JSON.stringify(text)}` };
    case 'bool':
      if (TRUE_RE.test(text)) return { ok: true, value: true };
      if (FALSE_RE.test(text)) return { ok: true, value: false };
      return { ok: false, message: `invalid !!bool value ${JSON.stringify(text)}` };
    case 'int': {
      const value = tryParseInt(text);
      if (value === undefined) {
        return { ok: false, message: `invalid !!int value ${JSON.stringify(text)}` };
      }
      return { ok: true, value };
    }
    case 'float': {
      // Unlike plain-scalar float detection, an explicit `!!float` tag also accepts
      // integer-shaped text (`!!float 1` means the float 1), since the tag itself already
      // disambiguates it from an int.
      const viaFloat = tryParseFloat(text);
      if (viaFloat !== undefined) return { ok: true, value: viaFloat };
      const viaInt = tryParseInt(text);
      if (viaInt !== undefined) {
        return { ok: true, value: typeof viaInt === 'bigint' ? Number(viaInt) : viaInt };
      }
      return { ok: false, message: `invalid !!float value ${JSON.stringify(text)}` };
    }
  }
}

const SUPPORTED_TAGS: ReadonlySet<string> = new Set(['str', 'int', 'float', 'bool', 'null']);

export function isSupportedTag(tag: string): tag is ExplicitTag {
  return SUPPORTED_TAGS.has(tag);
}
