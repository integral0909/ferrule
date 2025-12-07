/**
 * A small, hand-written glob matcher for the `file` source's `include`/`exclude` patterns.
 *
 * Deliberately does not compile patterns to a `RegExp`: an attacker-influenced (or just
 * pathological) pattern chaining wildcards can make naive regex translations backtrack
 * catastrophically. Matching here is dynamic programming over path segments and, within a
 * segment, over characters — both are worst-case `O(pattern length * input length)` with no
 * backtracking, so match time is always linear in the sizes of the two inputs.
 *
 * Supported syntax:
 * - `*`  matches zero or more characters within one path segment (never `/`).
 * - `**` as a whole path segment matches zero or more whole path segments (including zero,
 *   so `a/**\/b` matches `a/b`).
 * - `?`  matches exactly one character within one path segment (never `/`).
 * - `[abc]`, `[a-z]`, `[!abc]`, `[^abc]` character classes, negated with `!` or `^`.
 * - `{a,b,c}` brace alternation, expanded at compile time (top-level only; braces do not nest).
 *
 * A backslash has no special meaning; write patterns without needing to escape anything, which
 * is friendlier for the file paths this matcher is meant for.
 */
import { FerruleError } from '@ferrule/core';

const MAX_BRACE_EXPANSIONS = 256;

export class InvalidGlobError extends FerruleError {
  constructor(pattern: string, reason: string) {
    super('E_GLOB_SYNTAX', `invalid glob pattern ${JSON.stringify(pattern)}: ${reason}`);
    this.name = 'InvalidGlobError';
  }
}

type SegmentToken =
  | { readonly type: 'lit'; readonly ch: string }
  | { readonly type: 'any' }
  | { readonly type: 'star' }
  | { readonly type: 'class'; readonly negate: boolean; readonly test: (ch: string) => boolean };

/** A pattern compiled once, matched many times. */
export interface CompiledGlob {
  readonly source: string;
  test(candidate: string): boolean;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Expands top-level (non-nested) `{a,b,c}` groups into the cross product of literal patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new InvalidGlobError(pattern, 'unbalanced "{"');
  const prefix = pattern.slice(0, open);
  const body = pattern.slice(open + 1, close);
  const suffix = pattern.slice(close + 1);
  const alternatives = splitTopLevelCommas(body);
  const expandedSuffixes = expandBraces(suffix);
  const results: string[] = [];
  for (const alt of alternatives) {
    for (const suf of expandedSuffixes) {
      results.push(prefix + alt + suf);
      if (results.length > MAX_BRACE_EXPANSIONS) {
        throw new InvalidGlobError(
          pattern,
          `too many brace alternatives (max ${MAX_BRACE_EXPANSIONS})`,
        );
      }
    }
  }
  return results;
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function tokenizeSegment(segment: string, pattern: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  let i = 0;
  while (i < segment.length) {
    const c = segment[i]!;
    if (c === '*') {
      tokens.push({ type: 'star' });
      i++;
    } else if (c === '?') {
      tokens.push({ type: 'any' });
      i++;
    } else if (c === '[') {
      const end = segment.indexOf(']', i + 2); // ']' immediately after '[' or '[!' is a literal
      if (end === -1) {
        tokens.push({ type: 'lit', ch: '[' });
        i++;
        continue;
      }
      let body = segment.slice(i + 1, end);
      let negate = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true;
        body = body.slice(1);
      }
      const test = compileCharClass(body, pattern);
      tokens.push({ type: 'class', negate, test });
      i = end + 1;
    } else {
      tokens.push({ type: 'lit', ch: c });
      i++;
    }
  }
  return tokens;
}

function compileCharClass(body: string, pattern: string): (ch: string) => boolean {
  if (body === '') throw new InvalidGlobError(pattern, 'empty character class');
  const singles = new Set<string>();
  const ranges: [string, string][] = [];
  let i = 0;
  while (i < body.length) {
    const lo = body[i]!;
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const hi = body[i + 2]!;
      ranges.push([lo, hi]);
      i += 3;
    } else {
      singles.add(lo);
      i += 1;
    }
  }
  return (ch: string): boolean => {
    if (singles.has(ch)) return true;
    for (const [lo, hi] of ranges) {
      if (ch >= lo && ch <= hi) return true;
    }
    return false;
  };
}

function tokenMatches(token: SegmentToken, ch: string): boolean {
  switch (token.type) {
    case 'lit':
      return token.ch === ch;
    case 'any':
      return true;
    case 'class':
      return token.negate ? !token.test(ch) : token.test(ch);
    case 'star':
      throw new Error('unreachable: star handled by matchSegment');
  }
}

/** Matches one path segment (no `/`) against one pattern segment's tokens. Linear DP, no backtracking. */
function matchSegment(tokens: readonly SegmentToken[], input: string): boolean {
  const n = tokens.length;
  const m = input.length;
  // dp[j] tracks whether tokens[0..i) matches input[0..j) for the row currently being computed.
  let prev = new Array<boolean>(m + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= n; i++) {
    const token = tokens[i - 1]!;
    const cur = new Array<boolean>(m + 1).fill(false);
    if (token.type === 'star') {
      cur[0] = prev[0]!;
      for (let j = 1; j <= m; j++) cur[j] = cur[j - 1]! || prev[j]!;
    } else {
      for (let j = 1; j <= m; j++) {
        cur[j] = prev[j - 1]! && tokenMatches(token, input[j - 1]!);
      }
    }
    prev = cur;
  }
  return prev[m]!;
}

function matchSegments(
  patternSegments: readonly string[],
  inputSegments: readonly string[],
): boolean {
  const n = patternSegments.length;
  const m = inputSegments.length;
  // dp[i][j]: pattern segments [0,i) match input segments [0,j)
  const dp: boolean[][] = Array.from({ length: n + 1 }, () =>
    new Array<boolean>(m + 1).fill(false),
  );
  dp[0]![0] = true;
  for (let i = 1; i <= n; i++) {
    const seg = patternSegments[i - 1]!;
    if (seg === '**') {
      dp[i]![0] = dp[i - 1]![0]!;
      for (let j = 1; j <= m; j++) dp[i]![j] = dp[i]![j - 1]! || dp[i - 1]![j]!;
    } else {
      const tokens = tokenizeSegment(seg, patternSegments.join('/'));
      for (let j = 1; j <= m; j++) {
        dp[i]![j] = dp[i - 1]![j - 1]! && matchSegment(tokens, inputSegments[j - 1]!);
      }
    }
  }
  return dp[n]![m]!;
}

/** Compiles `pattern` once for repeated matching against candidate paths. */
export function compileGlob(pattern: string): CompiledGlob {
  const normalized = normalizeSlashes(pattern);
  const alternatives = expandBraces(normalized).map((alt) => alt.split('/'));
  return {
    source: pattern,
    test: (candidate: string): boolean => {
      const segments = normalizeSlashes(candidate).split('/');
      return alternatives.some((alt) => matchSegments(alt, segments));
    },
  };
}

/** Compiles and matches in one call. Prefer {@link compileGlob} when matching many candidates. */
export function matchGlob(pattern: string, candidate: string): boolean {
  return compileGlob(pattern).test(candidate);
}

/**
 * The longest path prefix of `pattern` that contains no wildcard, i.e. the deepest directory a
 * file-system walk needs to start from to find every match. `"/var/log/**\/*.log"` → `"/var/log"`;
 * a pattern with no directory separator before its first wildcard yields `"."`.
 */
export function globStaticPrefix(pattern: string): string {
  const normalized = normalizeSlashes(pattern);
  const segments = normalized.split('/');
  const staticSegments: string[] = [];
  for (const seg of segments) {
    if (/[*?[{]/.test(seg)) break;
    staticSegments.push(seg);
  }
  if (staticSegments.length === segments.length) staticSegments.pop(); // the pattern is a literal file
  if (staticSegments.length === 0) return normalized.startsWith('/') ? '/' : '.';
  const prefix = staticSegments.join('/');
  return prefix === '' ? '/' : prefix;
}
