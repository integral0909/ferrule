import type { RuntimeValue } from './context.js';
import { scriptKindOf } from './kinds.js';
import { getCachedRegex, type RegexCacheResult } from './regexCache.js';
import { isRegexValue } from './regex.js';

/**
 * Shared `string | regex` pattern resolution for every stdlib function that treats a plain
 * `string` pattern argument as regex *source text* (`parse_regex`, `parse_regex_all`, `matches`,
 * `redact`) — as opposed to functions like `replace`/`split`, whose `string` pattern means a
 * literal substring, never a regex. See `stdlib/parsing.ts`'s module doc for why these two
 * conventions coexist.
 */

/** Resolves a `string | regex` argument to a `RegExp` for a single, non-global match/test. */
export function resolvePatternForMatch(pattern: RuntimeValue): RegexCacheResult {
  if (isRegexValue(pattern)) return { ok: true, regex: pattern.regex };
  if (typeof pattern === 'string') return getCachedRegex(pattern, '');
  return {
    ok: false,
    message: `expected a string or regex pattern, found ${scriptKindOf(pattern)}`,
  };
}

/** Resolves a `string | regex` argument to a `g`-flagged `RegExp` for `matchAll`-style iteration. */
export function resolvePatternForIteration(pattern: RuntimeValue): RegexCacheResult {
  if (isRegexValue(pattern)) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return { ok: true, regex: new RegExp(pattern.source, flags) };
  }
  if (typeof pattern === 'string') return getCachedRegex(pattern, 'g');
  return {
    ok: false,
    message: `expected a string or regex pattern, found ${scriptKindOf(pattern)}`,
  };
}
