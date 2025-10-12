import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePath } from '@ferrule/core';
import {
  BloomFilter,
  coerceValue,
  compileTemplate,
  conditionSchema,
  evaluateCondition,
  fingerprintValue,
  hashString,
  LruCache,
  refillRatePerMs,
  TokenBucket,
  TtlLruCache,
  toNumber,
  unitInterval,
} from '@ferrule/operators';

describe('hash', () => {
  it('hashString is deterministic', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('unitInterval always returns a value in [0, 1)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const u = unitInterval(hashString(s));
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }),
    );
  });

  it('fingerprintValue distinguishes integer, float, and string forms of "1"', () => {
    const a = fingerprintValue(1n);
    const b = fingerprintValue(1);
    const c = fingerprintValue('1');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('fingerprintValue is independent of Map key insertion order', () => {
    const a = fingerprintValue(
      new Map([
        ['x', 1n],
        ['y', 2n],
      ]),
    );
    const b = fingerprintValue(
      new Map([
        ['y', 2n],
        ['x', 1n],
      ]),
    );
    expect(a).toBe(b);
  });
});

describe('LruCache', () => {
  it('evicts the least-recently-used entry beyond maxSize', () => {
    const evicted: string[] = [];
    const cache = new LruCache<number>({ maxSize: 2, onEvict: (k) => evicted.push(k) });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch: 'b' is now the least-recently-used
    cache.set('c', 3);
    expect(evicted).toEqual(['b']);
    expect([...cache.keys()].sort()).toEqual(['a', 'c']);
  });
});

describe('TtlLruCache', () => {
  it('expires entries lazily after their TTL', () => {
    const cache = new TtlLruCache<string>({ maxSize: 10 });
    cache.set('k', 'v', 0, 100);
    expect(cache.get('k', 50)).toBe('v');
    expect(cache.get('k', 150)).toBeUndefined();
  });
});

describe('TokenBucket', () => {
  it('admits up to capacity, then refuses until refilled', () => {
    const bucket = new TokenBucket(2, 1 / 1000, 0);
    expect(bucket.tryRemove(1, 0)).toBe(true);
    expect(bucket.tryRemove(1, 0)).toBe(true);
    expect(bucket.tryRemove(1, 0)).toBe(false);
    expect(bucket.tryRemove(1, 1000)).toBe(true);
  });

  it('refillRatePerMs computes events-per-window as a per-ms rate', () => {
    expect(refillRatePerMs(100, 1000)).toBeCloseTo(0.1);
  });
});

describe('BloomFilter', () => {
  it('never reports a false negative for an added key', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 200 }), (keys) => {
        const bloom = new BloomFilter(keys.length, 0.01);
        for (const k of keys) bloom.add(k);
        for (const k of keys) expect(bloom.has(k)).toBe(true);
      }),
    );
  });

  it('addIfAbsent reports true exactly on the first insertion of a key', () => {
    const bloom = new BloomFilter(10, 0.01);
    expect(bloom.addIfAbsent('x')).toBe(true);
    expect(bloom.addIfAbsent('x')).toBe(false);
  });
});

describe('compileTemplate', () => {
  it('substitutes {field.path} references', () => {
    const t = compileTemplate('hello {name}!');
    expect(t.render((p) => (p.join('.') === 'name' ? 'world' : undefined))).toBe('hello world!');
  });

  it('{{ and }} escape literal braces', () => {
    const t = compileTemplate('a {{literal}} b');
    expect(t.render(() => undefined)).toBe('a {literal} b');
  });

  it('isConstant is true only without field references', () => {
    expect(compileTemplate('plain text').isConstant).toBe(true);
    expect(compileTemplate('has {a} field').isConstant).toBe(false);
  });
});

describe('coerceValue', () => {
  it('round-trips int -> string -> int', () => {
    const s = coerceValue(42n, 'string');
    expect(s).toBe('42');
    expect(coerceValue(s as string, 'int')).toBe(42n);
  });

  it('bool parses common truthy/falsy strings', () => {
    expect(coerceValue('yes', 'bool')).toBe(true);
    expect(coerceValue('no', 'bool')).toBe(false);
    expect(coerceValue('not a bool', 'bool')).toBeUndefined();
  });

  it('timestamp parses unix_seconds', () => {
    const t = coerceValue(1700000000, 'timestamp', 'unix_seconds');
    expect(t).toBeDefined();
  });

  it('toNumber extracts a number from common representations', () => {
    expect(toNumber(3n)).toBe(3);
    expect(toNumber(3.5)).toBe(3.5);
    expect(toNumber('3.5')).toBe(3.5);
    expect(toNumber(true)).toBe(1);
    expect(toNumber('nope')).toBeUndefined();
  });
});

describe('conditionSchema / evaluateCondition', () => {
  const get = (fields: Record<string, unknown>) => (path: readonly (string | number)[]) => {
    const raw = fields[path.join('.')];
    return raw === undefined ? undefined : (raw as never);
  };

  it('field_exists / field_equals / field_matches', () => {
    const exists = conditionSchema().parse({ type: 'field_exists', field: 'a' });
    expect(evaluateCondition(exists, get({ a: 1n }))).toBe(true);
    expect(evaluateCondition(exists, get({}))).toBe(false);

    const equals = conditionSchema().parse({ type: 'field_equals', field: 'a', value: 5 });
    expect(evaluateCondition(equals, get({ a: 5n }))).toBe(true);
    expect(evaluateCondition(equals, get({ a: 6n }))).toBe(false);

    const matches = conditionSchema().parse({ type: 'field_matches', field: 'a', pattern: '^x' });
    expect(evaluateCondition(matches, get({ a: 'xyz' }))).toBe(true);
    expect(evaluateCondition(matches, get({ a: 'yz' }))).toBe(false);
  });

  it('and / or / not compose', () => {
    const spec = conditionSchema().parse({
      type: 'and',
      conditions: [
        { type: 'field_exists', field: 'a' },
        { type: 'not', condition: { type: 'field_exists', field: 'b' } },
      ],
    });
    expect(evaluateCondition(spec, get({ a: 1n }))).toBe(true);
    expect(evaluateCondition(spec, get({ a: 1n, b: 2n }))).toBe(false);
  });

  it('rejects a malformed condition with a schema issue', () => {
    const result = conditionSchema().safeParse({ type: 'nope' });
    expect(result.ok).toBe(false);
  });
});

// Sanity check that parsePath (used throughout the package) is imported correctly in this suite.
describe('parsePath sanity', () => {
  it('parses a simple field path', () => {
    expect(parsePath('a.b')).toEqual(['a', 'b']);
  });
});
