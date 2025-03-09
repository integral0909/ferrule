import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emitYaml, nodeToPlain, parseYamlDocument } from '@ferrule/config';

function roundTrip(value: unknown): unknown {
  const text = emitYaml(value);
  return nodeToPlain(parseYamlDocument(text), 'roundtrip.yaml').value;
}

const arbScalar = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.bigInt({
    min: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    max: BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n,
  }),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n) && Number.isFinite(n)),
  fc.string(),
);

const safeKey = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');

const arbConfigValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    arbScalar,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(safeKey, tie('value'), { maxKeys: 4 }),
  ),
})).value;

describe('emitYaml', () => {
  it('round-trips arbitrary config-shaped values through parseYamlDocument', () => {
    fc.assert(
      fc.property(arbConfigValue, (value) => {
        expect(roundTrip(value)).toEqual(value);
      }),
      { numRuns: 300 },
    );
  });

  it('renders simple mappings readably', () => {
    const text = emitYaml({ a: 1, b: 'two', c: true, d: null });
    expect(text).toBe('a: 1\nb: two\nc: true\nd: null\n');
  });

  it('quotes strings that would otherwise change meaning', () => {
    expect(emitYaml({ a: 'true' })).toBe('a: "true"\n');
    expect(emitYaml({ a: '123' })).toBe('a: "123"\n');
    expect(emitYaml({ a: '' })).toBe('a: ""\n');
    expect(emitYaml({ a: '- dash' })).toBe('a: "- dash"\n');
    expect(emitYaml({ a: 'key: value' })).toBe('a: "key: value"\n');
  });

  it('escapes control characters in double-quoted output', () => {
    expect(emitYaml({ a: 'line1\nline2' })).toBe('a: "line1\\nline2"\n');
  });

  it('leaves an embedded (non-leading) quote unquoted, since it is not special mid-scalar', () => {
    expect(emitYaml({ a: 'a"b' })).toBe('a: a"b\n');
  });

  it('quotes and escapes a string that starts with a quote character', () => {
    expect(emitYaml({ a: '"quoted"' })).toBe('a: "\\"quoted\\""\n');
  });

  it('renders nested mappings, sequences, and sequences of mappings', () => {
    const value = { sinks: { store: { type: 'clickhouse', inputs: ['a', 'b'] } } };
    const text = emitYaml(value);
    expect(nodeToPlain(parseYamlDocument(text), 'x.yaml').value).toEqual(value);
    expect(text).toContain('sinks:\n');
  });

  it('renders empty containers compactly', () => {
    expect(emitYaml({ a: [], b: {} })).toBe('a: []\nb: {}\n');
  });

  it('renders large integers exactly', () => {
    const value = { a: 9_223_372_036_854_775_807n };
    expect(roundTrip(value)).toEqual(value);
  });

  it('renders special float values', () => {
    expect(roundTrip({ a: Infinity })).toEqual({ a: Infinity });
    expect(roundTrip({ a: -Infinity })).toEqual({ a: -Infinity });
    expect((roundTrip({ a: NaN }) as { a: number }).a).toBeNaN();
  });
});
