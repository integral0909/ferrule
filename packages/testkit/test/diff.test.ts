import { describe, expect, it } from 'vitest';
import { fromPlain } from '@ferrule/core';
import {
  assertEventMatches,
  assertEveryEventMatches,
  containsEventMatching,
  counter,
  diffValues,
  eventToValue,
  formatDiffs,
  log,
  span,
} from '@ferrule/testkit';

describe('diffValues', () => {
  it('subset mode ignores extra actual fields', () => {
    const expected = fromPlain({ a: 1 });
    const actual = fromPlain({ a: 1, b: 2 });
    expect(diffValues(expected, actual, 'subset')).toEqual([]);
  });

  it('exact mode reports extra actual fields', () => {
    const expected = fromPlain({ a: 1 });
    const actual = fromPlain({ a: 1, b: 2 });
    const diffs = diffValues(expected, actual, 'exact');
    expect(diffs).toEqual([{ path: 'b', expected: undefined, actual: 2n }]);
  });

  it('reports a mismatched scalar with its path', () => {
    const diffs = diffValues(fromPlain({ status: 200 }), fromPlain({ status: 500 }), 'subset');
    expect(diffs).toEqual([{ path: 'status', expected: 200n, actual: 500n }]);
  });

  it('reports a missing field', () => {
    const diffs = diffValues(fromPlain({ status: 200 }), fromPlain({}), 'subset');
    expect(diffs).toEqual([{ path: 'status', expected: 200n, actual: undefined }]);
  });

  it('recurses into nested objects with dotted paths', () => {
    const diffs = diffValues(fromPlain({ a: { b: 1 } }), fromPlain({ a: { b: 2 } }), 'subset');
    expect(diffs).toEqual([{ path: 'a.b', expected: 1n, actual: 2n }]);
  });

  it('compares arrays element-by-element with bracketed paths', () => {
    const diffs = diffValues(fromPlain({ xs: [1, 2] }), fromPlain({ xs: [1, 3] }), 'subset');
    expect(diffs).toEqual([{ path: 'xs[1]', expected: 2n, actual: 3n }]);
  });

  it('an array length mismatch is one diff at the array path', () => {
    const diffs = diffValues(fromPlain({ xs: [1, 2] }), fromPlain({ xs: [1] }), 'subset');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe('xs');
  });

  it('int and float are never equal', () => {
    const diffs = diffValues(
      fromPlain({ n: 1 }, { numbers: 'float' }),
      fromPlain({ n: 1 }),
      'subset',
    );
    expect(diffs).toEqual([{ path: 'n', expected: 1, actual: 1n }]);
  });

  it('formatDiffs renders a readable multi-line message', () => {
    const diffs = diffValues(fromPlain({ a: 1, b: 2 }), fromPlain({ a: 9 }), 'subset');
    const text = formatDiffs(diffs);
    expect(text).toContain('a: expected 1, got 9');
    expect(text).toContain('b: expected 2, missing');
  });
});

describe('eventToValue', () => {
  it('a log event is its own fields', () => {
    const event = log({ a: 1 });
    expect(eventToValue(event)).toBe(event.fields);
  });

  it('a metric event becomes a structured object', () => {
    const event = counter('requests', 3, { tags: { host: 'a' } });
    const value = eventToValue(event);
    const expected = fromPlain(
      {
        name: 'requests',
        kind: 'incremental',
        tags: { host: 'a' },
        value: { type: 'counter', value: 3 },
      },
      { numbers: 'float' }, // MetricValue's counter/gauge `value` is always a float, never int64
    );
    expect(diffValues(expected, value, 'exact')).toEqual([]);
  });

  it('a span event becomes a structured object with hex IDs', () => {
    const event = span('op', { status: { code: 'ok' } });
    const value = eventToValue(event);
    expect(diffValues(fromPlain({ name: 'op', status: { code: 'ok' } }), value, 'subset')).toEqual(
      [],
    );
  });
});

describe('matchers', () => {
  it('assertEventMatches passes for a subset match', () => {
    expect(() => assertEventMatches(log({ a: 1, b: 2 }), { a: 1 })).not.toThrow();
  });

  it('assertEventMatches throws with a diff message on mismatch', () => {
    expect(() => assertEventMatches(log({ a: 1 }), { a: 2 })).toThrowError(/expected 2, got 1/);
  });

  it('containsEventMatching finds a matching event among several', () => {
    const events = [log({ a: 1 }), log({ a: 2 })];
    expect(containsEventMatching(events, { a: 2 })).toBe(true);
    expect(containsEventMatching(events, { a: 3 })).toBe(false);
  });

  it('assertEveryEventMatches throws naming the failing index', () => {
    const events = [log({ a: 1 }), log({ a: 2 })];
    expect(() => assertEveryEventMatches(events, { a: 1 })).toThrowError(/event\[1\]/);
  });
});
