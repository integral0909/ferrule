import fc from 'fast-check';
import { INT64_MAX, INT64_MIN, Timestamp, type Value, type ValueMap } from '@ferrule/core';

export const arbInteger: fc.Arbitrary<bigint> = fc.bigInt({ min: INT64_MIN, max: INT64_MAX });

export const arbFloat: fc.Arbitrary<number> = fc.double();

export const arbTimestamp: fc.Arbitrary<Timestamp> = fc
  .bigInt({ min: -62_135_596_800_000_000_000n, max: 253_402_300_799_999_999_999n })
  .map((n) => Timestamp.fromNanos(n));

export const arbScalar: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  arbInteger,
  arbFloat,
  fc.string({ unit: 'binary' }),
  fc.uint8Array({ maxLength: 16 }),
  arbTimestamp,
);

/** Arbitrary Ferrule values, nested up to a few levels deep. */
export const arbValue: fc.Arbitrary<Value> = fc.letrec<{ value: Value; map: ValueMap }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    arbScalar,
    fc.array(tie('value'), { maxLength: 4 }),
    tie('map'),
  ),
  map: fc
    .array(fc.tuple(fc.string(), tie('value')), { maxLength: 4 })
    .map((entries) => new Map(entries)),
})).value;

/** Values that survive a JSON round trip unchanged: no bytes, timestamps, or non-finite floats. */
export const arbJsonValue: fc.Arbitrary<Value> = fc.letrec<{ value: Value; map: ValueMap }>(
  (tie) => ({
    value: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.constant(null),
      fc.boolean(),
      arbInteger,
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string({ unit: 'binary' }),
      fc.array(tie('value'), { maxLength: 4 }),
      tie('map'),
    ),
    map: fc
      .array(fc.tuple(fc.string({ unit: 'binary' }), tie('value')), { maxLength: 4 })
      .map((entries) => new Map(entries)),
  }),
).value;
