/**
 * A small bounded cache from `(pattern, flags)` text to a compiled `RegExp` (or the error
 * compiling it produced), shared by every stdlib function that accepts a `string` where a regex
 * is conceptually needed (`parse_regex`, `parse_regex_all`, `matches`, `redact`): a call site that
 * always passes the same literal pattern (the overwhelmingly common case) pays the `RegExp`
 * compilation cost once, not on every event. Bounded (`MAX_ENTRIES`, evicting the
 * least-recently-used entry) so a program that builds patterns from unbounded event data cannot
 * grow this into an unbounded per-process cache.
 *
 * Callers must never call a stateful method (`exec`, `test` with a sticky/global flag, anything
 * that reads/writes `lastIndex`) directly on the returned `RegExp` without first either resetting
 * `lastIndex = 0` or constructing a fresh `RegExp` from its `.source`/`.flags` — the same object is
 * handed out to every caller that asks for the same pattern text.
 */

export type RegexCacheResult =
  { readonly ok: true; readonly regex: RegExp } | { readonly ok: false; readonly message: string };

const MAX_ENTRIES = 256;
const cache = new Map<string, RegexCacheResult>();

function cacheKey(pattern: string, flags: string): string {
  return `${flags}\u0000${pattern}`;
}

export function getCachedRegex(pattern: string, flags: string): RegexCacheResult {
  const key = cacheKey(pattern, flags);
  const existing = cache.get(key);
  if (existing !== undefined) {
    // Move to the end (most-recently-used) by re-inserting; Map iteration order is insertion order.
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }

  let result: RegexCacheResult;
  try {
    result = { ok: true, regex: new RegExp(pattern, flags) };
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, result);
  return result;
}

/** Test-only: clears the cache so tests can assert on cache size/behavior deterministically. */
export function clearRegexCacheForTests(): void {
  cache.clear();
}

export function regexCacheSizeForTests(): number {
  return cache.size;
}
