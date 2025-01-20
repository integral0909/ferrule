import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deletePath,
  formatPath,
  getPath,
  hasPath,
  isPathPrefix,
  objectOf,
  parsePath,
  parsePathCached,
  ParseError,
  setPath,
  walkLeaves,
  type Path,
  type Value,
  type ValueMap,
} from '@ferrule/core';

describe('parsePath', () => {
  it.each<[string, Path]>([
    ['.', []],
    ['', []],
    ['.message', ['message']],
    ['message', ['message']],
    ['.a.b.c', ['a', 'b', 'c']],
    ['.items[0]', ['items', 0]],
    ['.items[-1].id', ['items', -1, 'id']],
    ['.m[1][2]', ['m', 1, 2]],
    ['.[0]', [0]],
    ['.@timestamp', ['@timestamp']],
    ['."user-agent"', ['user-agent']],
    ['.headers."x.forwarded.for"', ['headers', 'x.forwarded.for']],
    ['."quote\\"inside"', ['quote"inside']],
    ['."\\u00e9"', ['é']],
    ['."a"[3]', ['a', 3]],
  ])('parses %j', (text, expected) => {
    expect(parsePath(text)).toEqual(expected);
  });

  it.each([
    '..a',
    '.a.',
    '.a[',
    '.a[x]',
    '.a[1',
    '.a b',
    '.a-b',
    '."unterminated',
    '."bad\\q"',
    '.a[99999999999999999999]',
  ])('rejects %j', (text) => {
    expect(() => parsePath(text)).toThrow(ParseError);
  });

  it('round-trips through formatPath', () => {
    const segment = fc.oneof(fc.string({ unit: 'binary' }), fc.integer({ min: -1000, max: 1000 }));
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 6 }), (path) => {
        expect(parsePath(formatPath(path))).toEqual(path);
      }),
    );
  });

  it('formats canonically', () => {
    expect(formatPath([])).toBe('.');
    expect(formatPath(['a', 0, 'b c', ''])).toBe('.a[0]."b c".""');
  });

  it('caches parsed paths and freezes them', () => {
    const a = parsePathCached('.x.y');
    expect(parsePathCached('.x.y')).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('getPath', () => {
  const root = objectOf({ a: { b: [10, 20, { c: 'deep' }] }, s: 'str' });

  it('reads nested fields and indices', () => {
    expect(getPath(root, ['a', 'b', 0])).toBe(10n);
    expect(getPath(root, ['a', 'b', -1, 'c'])).toBe('deep');
    expect(getPath(root, [])).toBe(root);
  });

  it('returns undefined for missing or mistyped steps', () => {
    expect(getPath(root, ['missing'])).toBeUndefined();
    expect(getPath(root, ['a', 'b', 3])).toBeUndefined();
    expect(getPath(root, ['a', 'b', -4])).toBeUndefined();
    expect(getPath(root, ['s', 'x'])).toBeUndefined();
    expect(getPath(root, ['a', 0])).toBeUndefined();
    expect(hasPath(root, ['a', 'b'])).toBe(true);
    expect(hasPath(root, ['a', 'z'])).toBe(false);
  });

  it('distinguishes an explicit null from a missing field', () => {
    const r = objectOf({ n: null });
    expect(getPath(r, ['n'])).toBeNull();
    expect(getPath(r, ['m'])).toBeUndefined();
  });
});

describe('setPath', () => {
  it('creates intermediate objects and arrays', () => {
    const root: ValueMap = new Map();
    expect(setPath(root, ['a', 'b', 2, 'c'], 1n)).toBe(true);
    expect(root).toEqual(objectOf({ a: { b: [null, null, { c: 1 }] } }));
  });

  it('overwrites existing values and replaces mistyped intermediates', () => {
    const root = objectOf({ a: 'string', list: [1, 2] });
    setPath(root, ['a', 'b'], true);
    setPath(root, ['list', -1], 'last');
    expect(root).toEqual(objectOf({ a: { b: true }, list: [1, 'last'] }));
  });

  it('refuses negative indices that fall before the start without modifying anything', () => {
    const root = objectOf({ list: [1] });
    expect(setPath(root, ['list', -2], 0n)).toBe(false);
    expect(setPath(root, ['fresh', -1, 'x'], 0n)).toBe(false);
    expect(setPath(root, ['fresh', 0, 'y', -1], 0n)).toBe(false);
    expect(root).toEqual(objectOf({ list: [1] }));
  });

  it('refuses to set the root or index into it', () => {
    const root: ValueMap = new Map();
    expect(setPath(root, [], 1n)).toBe(false);
    expect(setPath(root, [0], 1n)).toBe(false);
    expect(root.size).toBe(0);
  });

  it('makes values readable at the same path', () => {
    const segment = fc.oneof(fc.string({ maxLength: 3 }), fc.nat({ max: 4 }));
    const arbPath = fc
      .tuple(fc.string({ maxLength: 3 }), fc.array(segment, { maxLength: 4 }))
      .map(([head, rest]) => [head, ...rest]);
    fc.assert(
      fc.property(arbPath, fc.string(), (path, value) => {
        const root: ValueMap = new Map();
        expect(setPath(root, path, value)).toBe(true);
        expect(getPath(root, path)).toBe(value);
      }),
    );
  });
});

describe('deletePath', () => {
  it('removes fields and array elements', () => {
    const root = objectOf({ a: { b: 1, c: 2 }, list: [1, 2, 3] });
    expect(deletePath(root, ['a', 'b'])).toBe(1n);
    expect(deletePath(root, ['list', -1])).toBe(3n);
    expect(deletePath(root, ['list', 0])).toBe(1n);
    expect(root).toEqual(objectOf({ a: { c: 2 }, list: [2] }));
  });

  it('returns undefined when there is nothing to remove', () => {
    const root = objectOf({ a: [1] });
    expect(deletePath(root, [])).toBeUndefined();
    expect(deletePath(root, ['x'])).toBeUndefined();
    expect(deletePath(root, ['a', 5])).toBeUndefined();
    expect(deletePath(root, ['a', 'k'])).toBeUndefined();
    expect(deletePath(root, ['x', 0])).toBeUndefined();
  });
});

describe('path utilities', () => {
  it('detects prefixes', () => {
    expect(isPathPrefix([], ['a'])).toBe(true);
    expect(isPathPrefix(['a'], ['a', 0])).toBe(true);
    expect(isPathPrefix(['a', 1], ['a', 0])).toBe(false);
    expect(isPathPrefix(['a', 'b'], ['a'])).toBe(false);
  });

  it('walks leaves in order, reporting empty containers as leaves', () => {
    const root = objectOf({ a: { b: 1, e: {} }, list: [true, []] });
    const seen: [string, Value][] = [];
    walkLeaves(root, (path, value) => seen.push([formatPath(path), value]));
    expect(seen).toEqual([
      ['.a.b', 1n],
      ['.a.e', new Map()],
      ['.list[0]', true],
      ['.list[1]', []],
    ]);
  });
});
