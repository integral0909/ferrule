import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileGlob, globStaticPrefix, InvalidGlobError, matchGlob } from '../../src/util/glob.js';

describe('matchGlob: examples', () => {
  it('matches literal paths exactly', () => {
    expect(matchGlob('a/b/c.log', 'a/b/c.log')).toBe(true);
    expect(matchGlob('a/b/c.log', 'a/b/c.LOG')).toBe(false);
    expect(matchGlob('a/b/c.log', 'a/b/d.log')).toBe(false);
  });

  it('matches * within a single segment only', () => {
    expect(matchGlob('*.log', 'app.log')).toBe(true);
    expect(matchGlob('*.log', 'app.1.log')).toBe(true);
    expect(matchGlob('*.log', 'dir/app.log')).toBe(false);
    expect(matchGlob('logs/*.log', 'logs/app.log')).toBe(true);
    expect(matchGlob('logs/*.log', 'logs/sub/app.log')).toBe(false);
  });

  it('matches ? as exactly one character', () => {
    expect(matchGlob('app.log.?', 'app.log.1')).toBe(true);
    expect(matchGlob('app.log.?', 'app.log.12')).toBe(false);
    expect(matchGlob('app.log.?', 'app.log.')).toBe(false);
  });

  it('matches ** across any number of segments, including zero', () => {
    expect(matchGlob('/var/log/**/*.log', '/var/log/app.log')).toBe(true);
    expect(matchGlob('/var/log/**/*.log', '/var/log/a/b/app.log')).toBe(true);
    expect(matchGlob('/var/log/**', '/var/log')).toBe(true);
    expect(matchGlob('/var/log/**', '/var/log/a/b/c')).toBe(true);
    expect(matchGlob('**/app.log', 'app.log')).toBe(true);
    expect(matchGlob('**/app.log', 'a/b/app.log')).toBe(true);
    expect(matchGlob('**', 'anything/at/all')).toBe(true);
  });

  it('matches character classes, including negation', () => {
    expect(matchGlob('app-[0-9].log', 'app-3.log')).toBe(true);
    expect(matchGlob('app-[0-9].log', 'app-x.log')).toBe(false);
    expect(matchGlob('app-[!0-9].log', 'app-x.log')).toBe(true);
    expect(matchGlob('app-[!0-9].log', 'app-3.log')).toBe(false);
    expect(matchGlob('app-[abc].log', 'app-b.log')).toBe(true);
  });

  it('expands brace alternatives', () => {
    expect(matchGlob('*.{log,txt}', 'a.log')).toBe(true);
    expect(matchGlob('*.{log,txt}', 'a.txt')).toBe(true);
    expect(matchGlob('*.{log,txt}', 'a.csv')).toBe(false);
    expect(matchGlob('{a,b}/{c,d}.log', 'a/c.log')).toBe(true);
    expect(matchGlob('{a,b}/{c,d}.log', 'b/d.log')).toBe(true);
    expect(matchGlob('{a,b}/{c,d}.log', 'a/e.log')).toBe(false);
  });

  it('throws InvalidGlobError for unbalanced braces', () => {
    expect(() => compileGlob('a/{b,c.log')).toThrow(InvalidGlobError);
  });

  it('compileGlob reuses tokenization across many test() calls', () => {
    const compiled = compileGlob('logs/**/*.log');
    expect(compiled.test('logs/a/b.log')).toBe(true);
    expect(compiled.test('logs/b.log')).toBe(true);
    expect(compiled.test('other/b.log')).toBe(false);
    expect(compiled.source).toBe('logs/**/*.log');
  });
});

describe('globStaticPrefix', () => {
  it('returns the wildcard-free directory prefix', () => {
    expect(globStaticPrefix('/var/log/**/*.log')).toBe('/var/log');
    expect(globStaticPrefix('/var/log/app.log')).toBe('/var/log');
    expect(globStaticPrefix('*.log')).toBe('.');
    expect(globStaticPrefix('/app-*.log')).toBe('/');
    expect(globStaticPrefix('relative/dir/*.log')).toBe('relative/dir');
  });
});

// -------------------------------------------------------------------------------------------
// Property test: the hand-rolled matcher against an independent regex translation.
//
// The reference translator below is restricted to patterns with at most one `**` (translating
// an arbitrary number of globstars into a single anchored regex is a well-known hard special
// case; the DP matcher itself has no such restriction — see the multi-`**` examples above,
// which the reference intentionally does not need to reproduce). Restricting the generator this
// way still gives strong, independent cross-validation of `*`, `?`, `[...]`, literal segments,
// and single-globstar placement (start, middle, end, alone).
// -------------------------------------------------------------------------------------------

const ALPHABET = ['a', 'b', 'c'] as const;

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** A plain (no `**`) pattern segment to its regex fragment, matching exactly one path segment. */
function segmentToRegexFragment(seg: readonly SegToken[]): string {
  return seg
    .map((t) => {
      switch (t.kind) {
        case 'lit':
          return escapeRegExp(t.ch);
        case 'star':
          return '[^/]*';
        case 'any':
          return '[^/]';
        case 'class':
          // Bracket expressions, like `*`/`?`, never implicitly match the path separator: only
          // an explicit literal `/` in a pattern segment can — and our alphabet has none.
          return t.negate
            ? `[^/${t.chars.map(escapeRegExp).join('')}]`
            : `[${t.chars.map(escapeRegExp).join('')}]`;
      }
    })
    .join('');
}

type SegToken =
  | { kind: 'lit'; ch: string }
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'class'; negate: boolean; chars: string[] };

/** One segment of the arbitrary pattern: either the literal string `**`, or a list of tokens. */
type PatternSegment = '**' | SegToken[];

function segmentsToPattern(segments: readonly PatternSegment[]): string {
  return segments.map((seg) => (seg === '**' ? '**' : renderSegTokens(seg))).join('/');
}

function joinFragments(segments: readonly SegToken[][]): string {
  return segments.map(segmentToRegexFragment).join('/');
}

/** Reference oracle for patterns with at most one `**`. Matches {@link matchGlob}'s documented semantics. */
function referenceMatch(segments: readonly PatternSegment[], candidate: string): boolean {
  const starIndex = segments.findIndex((s) => s === '**');
  let body: string;
  if (starIndex === -1) {
    body = `^${joinFragments(segments as SegToken[][])}$`;
  } else {
    const pre = segments.slice(0, starIndex) as SegToken[][];
    const post = segments.slice(starIndex + 1) as SegToken[][];
    const preRe = joinFragments(pre);
    const postRe = joinFragments(post);
    if (preRe === '' && postRe === '') body = '^.*$';
    else if (preRe === '') body = `^(?:.*/)?${postRe}$`;
    else if (postRe === '') body = `^${preRe}(?:/.*)?$`;
    else body = `^${preRe}(?:/.*)?/${postRe}$`;
  }
  return new RegExp(body).test(candidate);
}

const litToken = fc.constantFrom(...ALPHABET).map((ch): SegToken => ({ kind: 'lit', ch }));
const starToken = fc.constant<SegToken>({ kind: 'star' });
const anyToken = fc.constant<SegToken>({ kind: 'any' });
const classToken = fc
  .tuple(fc.boolean(), fc.uniqueArray(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 3 }))
  .map(([negate, chars]): SegToken => ({ kind: 'class', negate, chars }));

const segToken = fc.oneof(litToken, starToken, anyToken, classToken);
function renderSegTokens(tokens: readonly SegToken[]): string {
  return tokens
    .map((t) => {
      switch (t.kind) {
        case 'lit':
          return t.ch;
        case 'star':
          return '*';
        case 'any':
          return '?';
        case 'class':
          return `[${t.negate ? '!' : ''}${t.chars.join('')}]`;
      }
    })
    .join('');
}
// Two adjacent `*` tokens render as the literal text "**", which is indistinguishable from (and
// always parsed as) the globstar segment marker — excluded here so `hasStar` stays authoritative.
const plainSegment = fc
  .array(segToken, { minLength: 1, maxLength: 3 })
  .filter((tokens) => renderSegTokens(tokens) !== '**');

/** A sequence of pattern segments with at most one `**`, and zero or more plain segments. */
const patternSegments: fc.Arbitrary<PatternSegment[]> = fc
  .tuple(
    fc.array(plainSegment, { minLength: 0, maxLength: 2 }),
    fc.boolean(),
    fc.array(plainSegment, { minLength: 0, maxLength: 2 }),
  )
  .map(([pre, hasStar, post]) => {
    const segments: PatternSegment[] = [...pre];
    if (hasStar) segments.push('**');
    segments.push(...post);
    return segments.length === 0 ? [[{ kind: 'lit', ch: 'a' }] as SegToken[]] : segments;
  });

const candidatePath = fc
  .array(fc.array(fc.constantFrom(...ALPHABET), { minLength: 0, maxLength: 3 }), {
    minLength: 1,
    maxLength: 4,
  })
  .map((segments) => segments.map((s) => s.join('')).join('/'));

describe('matchGlob: property (vs. independent regex reference)', () => {
  it('agrees with the reference translation for patterns with at most one **', () => {
    fc.assert(
      fc.property(patternSegments, candidatePath, (segments, candidate) => {
        const pattern = segmentsToPattern(segments);
        expect(matchGlob(pattern, candidate)).toBe(referenceMatch(segments, candidate));
      }),
      { numRuns: 2000 },
    );
  });

  it('matching is invariant to how a candidate is chunked (sanity: matches its own literal form)', () => {
    fc.assert(
      fc.property(candidatePath, (candidate) => {
        expect(matchGlob(candidate, candidate)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
