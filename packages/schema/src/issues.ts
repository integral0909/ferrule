import { FerruleError } from '@ferrule/core';

/** Location of a value inside a configuration document: object keys and array indices. */
export type IssuePath = readonly (string | number)[];

/** One validation problem. `code` is stable; `message` is for humans. */
export interface Issue {
  path: IssuePath;
  code: IssueCode;
  message: string;
  /** Optional hint, e.g. a "did you mean" suggestion. */
  hint?: string;
}

export type IssueCode =
  | 'invalid_type'
  | 'required'
  | 'unknown_key'
  | 'too_small'
  | 'too_big'
  | 'invalid_string'
  | 'invalid_enum'
  | 'invalid_union'
  | 'invalid_format'
  | 'custom';

/** Formats a path like `sinks.store.batch.max_events` or `inputs[2]`. */
export function formatIssuePath(path: IssuePath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) out += out === '' ? segment : `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out === '' ? '(root)' : out;
}

export function formatIssue(issue: Issue): string {
  const hint = issue.hint === undefined ? '' : ` (${issue.hint})`;
  return `${formatIssuePath(issue.path)}: ${issue.message}${hint}`;
}

/** Raised by `Schema.parse` when input does not match. Carries every issue found, not just the first. */
export class SchemaValidationError extends FerruleError {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const lines = issues.map((issue) => `  - ${formatIssue(issue)}`);
    super('E_SCHEMA', `invalid configuration:\n${lines.join('\n')}`);
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

/** Describes the JavaScript type of an input value for error messages. */
export function describeInput(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'an array';
  switch (typeof input) {
    case 'object':
      return 'an object';
    case 'string':
      return 'a string';
    case 'number':
      return Number.isInteger(input) ? 'an integer' : 'a number';
    case 'boolean':
      return 'a boolean';
    case 'bigint':
      return 'an integer';
    case 'undefined':
      return 'nothing';
    default:
      return typeof input;
  }
}

/**
 * Optimal string alignment distance: Levenshtein plus adjacent transpositions, so a typo like
 * `prot` for `port` costs 1. Used for "did you mean" suggestions.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prevPrev[j - 2]! + 1);
      }
      cur[j] = d;
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The closest candidate within a distance proportional to the word's length, if any. Words
 * shorter than three characters get no suggestion; at that length almost everything is close.
 */
export function closestMatch(word: string, candidates: Iterable<string>): string | undefined {
  if (word.length < 3) return undefined;
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(word.length / 3)) + 1;
  for (const candidate of candidates) {
    const d = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}
