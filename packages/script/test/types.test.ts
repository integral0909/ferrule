import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  anyArrayType,
  anyObjectType,
  anyType,
  arrayType,
  boolType,
  floatType,
  formatExprType,
  formatType,
  handled,
  fallibleOf,
  intType,
  isSubtype,
  joinTypes,
  meetTypes,
  neverType,
  nullType,
  objectType,
  stringType,
  subtractType,
  type Type,
  typeFromKindName,
  typesEqual,
  unionType,
} from '@ferrule/script';

describe('types: construction and equality', () => {
  it('treats structurally identical types as equal', () => {
    expect(typesEqual(arrayType(intType), arrayType(intType))).toBe(true);
    expect(typesEqual(arrayType(intType), arrayType(floatType))).toBe(false);
    expect(typesEqual(objectType({ a: intType }), objectType({ a: intType }))).toBe(true);
    expect(typesEqual(objectType({ a: intType }), objectType({ a: floatType }))).toBe(false);
    expect(
      typesEqual(
        objectType({ a: intType, b: stringType }),
        objectType({ b: stringType, a: intType }),
      ),
    ).toBe(true);
  });

  it('normalizes unions: flattens, dedups, and unwraps singletons', () => {
    expect(unionType([intType])).toBe(intType);
    expect(unionType([intType, intType])).toBe(intType);
    expect(
      typesEqual(
        unionType([unionType([intType, stringType]), boolType]),
        unionType([intType, stringType, boolType]),
      ),
    ).toBe(true);
    expect(unionType([intType, neverType])).toBe(intType);
    expect(unionType([])).toBe(neverType);
    expect(unionType([intType, anyType])).toBe(anyType);
  });

  it('maps kind-pattern names to types', () => {
    expect(typeFromKindName('string')).toBe(stringType);
    expect(typeFromKindName('array')).toEqual(anyArrayType);
    expect(typeFromKindName('object')).toEqual(anyObjectType);
    expect(typeFromKindName('nonsense')).toBeUndefined();
  });
});

describe('types: subtyping', () => {
  it('makes `any` compatible with everything, both ways', () => {
    expect(isSubtype(intType, anyType)).toBe(true);
    expect(isSubtype(anyType, intType)).toBe(true);
  });

  it('makes `never` a subtype of everything but not vice versa', () => {
    expect(isSubtype(neverType, intType)).toBe(true);
    expect(isSubtype(intType, neverType)).toBe(false);
  });

  it('never implicitly mixes int and float', () => {
    expect(isSubtype(intType, floatType)).toBe(false);
    expect(isSubtype(floatType, intType)).toBe(false);
  });

  it('checks array covariance', () => {
    expect(isSubtype(arrayType(intType), arrayType(intType))).toBe(true);
    expect(isSubtype(arrayType(intType), arrayType(stringType))).toBe(false);
    expect(isSubtype(arrayType(intType), arrayType(anyType))).toBe(true);
  });

  it('allows extra fields (width subtyping) on a closed target', () => {
    const wide = objectType({ a: intType, b: stringType });
    const narrow = objectType({ a: intType });
    expect(isSubtype(wide, narrow)).toBe(true);
    expect(isSubtype(narrow, wide)).toBe(false);
  });

  it('checks field depth subtyping', () => {
    const a = objectType({ a: intType });
    const b = objectType({ a: anyType });
    expect(isSubtype(a, b)).toBe(true);
  });

  it('respects an open target shape with a rest type', () => {
    const target = objectType({}, stringType); // any fields, but all must be strings
    const okValue = objectType({ a: stringType, b: stringType });
    const badValue = objectType({ a: stringType, b: intType });
    expect(isSubtype(okValue, target)).toBe(true);
    expect(isSubtype(badValue, target)).toBe(false);
  });

  it('handles union subtyping in both positions', () => {
    const u = unionType([intType, stringType]);
    expect(isSubtype(intType, u)).toBe(true);
    expect(isSubtype(boolType, u)).toBe(false);
    expect(isSubtype(u, unionType([intType, stringType, boolType]))).toBe(true);
    expect(isSubtype(u, intType)).toBe(false);
  });

  it('is reflexive for every constructed type (property)', () => {
    const arbType = typeArbitrary();
    fc.assert(
      fc.property(arbType, (t) => {
        expect(isSubtype(t, t)).toBe(true);
      }),
    );
  });
});

describe('types: join and meet', () => {
  it('joins equal types to themselves', () => {
    expect(joinTypes(intType, intType)).toBe(intType);
  });

  it('joins never with anything to that thing', () => {
    expect(joinTypes(neverType, stringType)).toBe(stringType);
    expect(joinTypes(stringType, neverType)).toBe(stringType);
  });

  it('joins unrelated types into a union', () => {
    expect(typesEqual(joinTypes(intType, stringType), unionType([intType, stringType]))).toBe(true);
  });

  it('joining with any collapses to any', () => {
    expect(joinTypes(anyType, stringType)).toBe(anyType);
  });

  it('meets any with a type to narrow to that type', () => {
    expect(meetTypes(anyType, stringType)).toBe(stringType);
  });

  it('meets unrelated concrete types to never (unreachable narrowing)', () => {
    expect(meetTypes(intType, stringType)).toBe(neverType);
  });

  it('meets a union with a member to that member', () => {
    expect(meetTypes(unionType([intType, stringType]), stringType)).toBe(stringType);
  });

  it('subtracts a member from a union', () => {
    const u = unionType([intType, stringType, boolType]);
    expect(typesEqual(subtractType(u, stringType), unionType([intType, boolType]))).toBe(true);
  });

  it('subtracting from `any` stays `any` (cannot narrow by exclusion alone)', () => {
    expect(subtractType(anyType, stringType)).toBe(anyType);
  });
});

describe('types: pretty printing', () => {
  it('formats primitives, arrays, objects, and unions', () => {
    expect(formatType(intType)).toBe('int');
    expect(formatType(arrayType(stringType))).toBe('array<string>');
    expect(formatType(objectType({ a: intType, b: stringType }))).toBe(
      'object { a: int, b: string }',
    );
    expect(formatType(objectType({}, anyType))).toBe('object { ..any }');
    expect(formatType(unionType([intType, stringType]))).toBe('int | string');
    expect(formatType(nullType)).toBe('null');
  });

  it('quotes object keys that are not simple identifiers', () => {
    expect(formatType(objectType({ 'a-b': intType }))).toBe('object { "a-b": int }');
  });

  it('formats fallibility with a trailing `!`', () => {
    expect(formatExprType(handled(intType))).toBe('int');
    expect(formatExprType(fallibleOf(intType))).toBe('int!');
  });
});

function typeArbitrary(depth = 2): fc.Arbitrary<Type> {
  const leaves = fc.constantFrom(
    nullType,
    boolType,
    intType,
    floatType,
    stringType,
    anyType,
    neverType,
  );
  if (depth <= 0) return leaves;
  return fc.oneof(
    leaves,
    typeArbitrary(depth - 1).map((t) => arrayType(t)),
    fc.array(typeArbitrary(depth - 1), { minLength: 1, maxLength: 3 }).map((ts) => unionType(ts)),
  );
}
