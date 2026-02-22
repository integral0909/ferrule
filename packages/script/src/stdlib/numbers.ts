import { compareValues, isInt64, Timestamp, wrapInt64, type Value } from '@ferrule/core';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import type { RuntimeValue } from '../runtime/context.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { isRegexValue } from '../runtime/regex.js';
import { formatStrftime } from '../runtime/strftime.js';
import {
  anyType,
  floatType,
  intType,
  stringType,
  timestampType,
  unionType,
} from '../types/types.js';
import { fn } from './helpers.js';

const numericType = unionType([intType, floatType]);

/** Numbers and time: `abs`/`floor`/`ceil`/`round`/`min`/`max`/`mod`, `now`, `format_timestamp`, `to_unix_timestamp`. */
export function registerNumbers(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'abs',
      [param('value', numericType)],
      (argTypes) => argTypes[0]?.type ?? numericType,
      'on-argument-mismatch',
      true,
      'Returns the absolute value of an int or float.',
      ['abs(-5)', 'abs(.delta)'],
    ),
  );
  impls?.register(impl('abs', (args) => numericUnary(args.positional[0] ?? null, 'abs')));

  registry.register(
    fn(
      'floor',
      [param('value', floatType)],
      floatType,
      'on-argument-mismatch',
      true,
      'Rounds a float down to the nearest integer value (still a float).',
      ['floor(1.9)'],
    ),
  );
  impls?.register(impl('floor', (args) => numericUnary(args.positional[0] ?? null, 'floor')));

  registry.register(
    fn(
      'ceil',
      [param('value', floatType)],
      floatType,
      'on-argument-mismatch',
      true,
      'Rounds a float up to the nearest integer value (still a float).',
      ['ceil(1.1)'],
    ),
  );
  impls?.register(impl('ceil', (args) => numericUnary(args.positional[0] ?? null, 'ceil')));

  registry.register(
    fn(
      'round',
      [
        param('value', floatType),
        param('precision', intType, { optional: true, namedOnly: true, defaultDoc: '0' }),
      ],
      floatType,
      'on-argument-mismatch',
      true,
      'Rounds a float to `precision` decimal digits (default 0), half away from zero.',
      ['round(1.005, precision: 2)'],
    ),
  );
  impls?.register(
    impl('round', (args) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'number') {
        return new Failure(`round requires a float, found ${scriptKindOf(v)}`);
      }
      const precisionArg = args.named.get('precision');
      const precision = typeof precisionArg === 'bigint' ? Number(precisionArg) : 0;
      const factor = 10 ** precision;
      return Math.round(v * factor) / factor;
    }),
  );

  registry.register(
    fn(
      'min',
      [param('a', anyType), param('b', anyType)],
      (argTypes) => argTypes[0]?.type ?? anyType,
      'never',
      true,
      'Returns the smaller of two values, by natural order (see `sort`).',
      ['min(.a, .b)'],
    ),
  );
  impls?.register(
    impl('min', (args) => {
      const a = args.positional[0] ?? null;
      const b = args.positional[1] ?? null;
      if (isRegexValue(a) || isRegexValue(b)) return a;
      // Natural order is only defined for plain Values; a regex nested inside a compared
      // array/object (rather than being `a`/`b` itself, already excluded above) is not specially
      // handled beyond this point.
      return compareValues(a as Value, b as Value) <= 0 ? a : b;
    }),
  );

  registry.register(
    fn(
      'max',
      [param('a', anyType), param('b', anyType)],
      (argTypes) => argTypes[0]?.type ?? anyType,
      'never',
      true,
      'Returns the larger of two values, by natural order (see `sort`).',
      ['max(.a, .b)'],
    ),
  );
  impls?.register(
    impl('max', (args) => {
      const a = args.positional[0] ?? null;
      const b = args.positional[1] ?? null;
      if (isRegexValue(a) || isRegexValue(b)) return a;
      return compareValues(a as Value, b as Value) >= 0 ? a : b;
    }),
  );

  registry.register(
    fn(
      'mod',
      [param('a', numericType), param('b', numericType)],
      (argTypes) => argTypes[0]?.type ?? numericType,
      'always',
      true,
      'Returns `a` modulo `b`, matching the `%` operator (fails for `int % 0`).',
      ['mod(.n, 60)!'],
    ),
  );
  impls?.register(
    impl('mod', (args) => {
      const a = args.positional[0] ?? null;
      const b = args.positional[1] ?? null;
      if (typeof a === 'bigint' && typeof b === 'bigint') {
        if (b === 0n) return new Failure('division by zero');
        return wrapInt64(a % b);
      }
      if (typeof a === 'number' && typeof b === 'number') return a % b;
      return new Failure(
        `mod requires two ints or two floats, found ${scriptKindOf(a)} and ${scriptKindOf(b)}`,
      );
    }),
  );

  impls?.register(impl('now', (_args, ctx) => ctx.clock()));

  registry.register(
    fn(
      'format_timestamp',
      [param('value', timestampType), param('format', stringType)],
      stringType,
      'never',
      true,
      'Formats a timestamp with a strftime-style pattern (`%Y %m %d %H %M %S %L %f %z %a %A %b %B %j %%`), always in UTC.',
      ['format_timestamp(%received_at, "%Y-%m-%dT%H:%M:%S%z")'],
    ),
  );
  impls?.register(
    impl('format_timestamp', (args) => {
      const v = args.positional[0] ?? null;
      const format = args.positional[1] ?? null;
      if (!(v instanceof Timestamp) || typeof format !== 'string') {
        return new Failure('format_timestamp requires a timestamp and a string format');
      }
      return formatStrftime(v, format);
    }),
  );

  registry.register(
    fn(
      'to_unix_timestamp',
      [
        param('value', timestampType),
        param('unit', stringType, { optional: true, namedOnly: true, defaultDoc: '"s"' }),
      ],
      intType,
      'always',
      true,
      'Converts a timestamp to a Unix time integer. `unit` is `"s"` (default), `"ms"`, `"us"`, or `"ns"`.',
      ['to_unix_timestamp(%received_at, unit: "ms")!'],
    ),
  );
  impls?.register(
    impl('to_unix_timestamp', (args) => {
      const v = args.positional[0] ?? null;
      if (!(v instanceof Timestamp)) return new Failure('to_unix_timestamp requires a timestamp');
      const unitArg = args.named.get('unit');
      const unit = typeof unitArg === 'string' ? unitArg : 's';
      let result: bigint;
      switch (unit) {
        case 's':
          result = v.toSecondsAndNanos().seconds;
          break;
        case 'ms':
          result = BigInt(v.toMillis());
          break;
        case 'us':
          result = v.nanos / 1_000n;
          break;
        case 'ns':
          result = v.nanos;
          break;
        default:
          return new Failure(
            `unknown unit ${JSON.stringify(unit)}: expected "s", "ms", "us", or "ns"`,
          );
      }
      if (!isInt64(result)) return new Failure(`${result} is out of int64 range`);
      return result;
    }),
  );
}

function numericUnary(v: RuntimeValue, op: 'abs' | 'floor' | 'ceil'): RuntimeValue | Failure {
  if (op === 'abs') {
    if (typeof v === 'bigint') return v < 0n ? wrapInt64(-v) : v;
    if (typeof v === 'number') return Math.abs(v);
    return new Failure(`abs requires an int or float, found ${scriptKindOf(v)}`);
  }
  if (typeof v !== 'number') return new Failure(`${op} requires a float, found ${scriptKindOf(v)}`);
  return op === 'floor' ? Math.floor(v) : Math.ceil(v);
}
