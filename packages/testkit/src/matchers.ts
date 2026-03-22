import { fromPlain, type Event } from '@ferrule/core';
import { diffValues, eventToValue, formatDiffs, type FieldDiff, type MatchMode } from './diff.js';

/**
 * Assertion helpers built on `diff.ts`, for use directly inside a Vitest `it()` block (rather
 * than registering global `expect.extend` matchers, which would make `@ferrule/testkit` depend
 * on a particular Vitest version just for its matcher types — these are plain functions that
 * throw a descriptive `Error` on failure, which Vitest (or any test runner) reports exactly like
 * a failed `expect()`).
 */

/** Diffs one event's value representation against a plain JSON-ish `expected` shape. */
export function diffEvent(
  actual: Event,
  expected: Record<string, unknown> | unknown[],
  mode: MatchMode = 'subset',
): FieldDiff[] {
  const expectedValue = fromPlain(expected);
  return diffValues(expectedValue, eventToValue(actual), mode);
}

/** Throws with a formatted diff if `actual` does not match `expected` under `mode`. */
export function assertEventMatches(
  actual: Event,
  expected: Record<string, unknown> | unknown[],
  mode: MatchMode = 'subset',
): void {
  const diffs = diffEvent(actual, expected, mode);
  if (diffs.length > 0) {
    throw new Error(`event does not match (${mode}):\n${formatDiffs(diffs)}`);
  }
}

/** True if any event in `actual` matches `expected` under `mode`. */
export function containsEventMatching(
  actual: readonly Event[],
  expected: Record<string, unknown> | unknown[],
  mode: MatchMode = 'subset',
): boolean {
  return actual.some((event) => diffEvent(event, expected, mode).length === 0);
}

/** Throws unless every event in `actual` matches `expected` under `mode`. */
export function assertEveryEventMatches(
  actual: readonly Event[],
  expected: Record<string, unknown> | unknown[],
  mode: MatchMode = 'subset',
): void {
  const failures = actual
    .map((event, i) => ({ i, diffs: diffEvent(event, expected, mode) }))
    .filter((r) => r.diffs.length > 0);
  if (failures.length > 0) {
    const message = failures.map((f) => `event[${f.i}]:\n${formatDiffs(f.diffs)}`).join('\n\n');
    throw new Error(`${failures.length}/${actual.length} event(s) did not match:\n\n${message}`);
  }
}
