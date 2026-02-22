import { isInt64, Timestamp } from '@ferrule/core';
import { anyType, boolType, floatType, stringType, timestampType } from '../types/types.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { toLiteralString } from '../runtime/display.js';
import { Failure } from '../runtime/failure.js';
import { matchesKindName, scriptKindOf } from '../runtime/kinds.js';
import { isRegexValue } from '../runtime/regex.js';
import type { RuntimeValue } from '../runtime/context.js';
import { fn } from './helpers.js';

/**
 * Type checks and coercion: `is_*` for every runtime kind, `to_int`/`to_float`/`to_string`/
 * `to_bool`/`to_timestamp`, and `type_of`. `is_string`/`is_int`/`to_int`/`to_string` already have
 * signatures in `registry/builtins.ts` (the checker's own milestone fixtures); this module adds
 * only their implementations, plus signature *and* implementation for everything else.
 */
export function registerTypeChecks(
  registry: FunctionRegistry,
  impls?: ImplementationRegistry,
): void {
  registerIsKind(registry, impls, 'is_null', 'null', true);
  registerIsKind(registry, impls, 'is_bool', 'bool', true);
  registerIsKind(registry, impls, 'is_int', 'int', false);
  registerIsKind(registry, impls, 'is_float', 'float', true);
  registerIsKind(registry, impls, 'is_string', 'string', false);
  registerIsKind(registry, impls, 'is_bytes', 'bytes', true);
  registerIsKind(registry, impls, 'is_timestamp', 'timestamp', true);
  registerIsKind(registry, impls, 'is_array', 'array', true);
  registerIsKind(registry, impls, 'is_object', 'object', true);
  registerIsKind(registry, impls, 'is_regex', 'regex', true);

  impls?.register(impl('to_int', (args) => toIntValue(args.positional[0] ?? null)));
  impls?.register(impl('to_string', (args) => toLiteralString(args.positional[0] ?? null)));

  registry.register(
    fn(
      'to_float',
      [param('value', anyType, { doc: 'the value to convert' })],
      floatType,
      'always',
      true,
      'Converts a value to a float. `int`/`bool` convert exactly; a `string` is parsed as a decimal number.',
      ['to_float(.latency_ms) ?? 0.0'],
    ),
  );
  impls?.register(impl('to_float', (args) => toFloatValue(args.positional[0] ?? null)));

  registry.register(
    fn(
      'to_bool',
      [param('value', anyType, { doc: 'the value to convert' })],
      boolType,
      'always',
      true,
      'Converts a value to a bool. `int`/`float` are true unless zero; `"true"`/`"false"`/`"yes"`/`"no"`/`"1"`/`"0"` (case-insensitive) convert from `string`; `null` is `false`.',
      ['to_bool(.enabled) ?? false'],
    ),
  );
  impls?.register(impl('to_bool', (args) => toBoolValue(args.positional[0] ?? null)));

  registry.register(
    fn(
      'to_timestamp',
      [param('value', anyType, { doc: 'the value to convert' })],
      timestampType,
      'always',
      true,
      'Converts a value to a timestamp. A `string` is parsed as RFC 3339; `int`/`float` are interpreted as Unix seconds.',
      ['to_timestamp(.ts)!'],
    ),
  );
  impls?.register(impl('to_timestamp', (args) => toTimestampValue(args.positional[0] ?? null)));

  registry.register(
    fn(
      'type_of',
      [param('value', anyType)],
      stringType,
      'never',
      true,
      'Returns the name of a value\'s runtime kind: `"null"`, `"bool"`, `"int"`, `"float"`, `"string"`, `"bytes"`, `"timestamp"`, `"array"`, `"object"`, or `"regex"`.',
      ['type_of(.value) == "string"'],
    ),
  );
  impls?.register(
    impl('type_of', (args) => languageTypeName(scriptKindOf(args.positional[0] ?? null))),
  );
}

/** Maps a runtime `ScriptKind` (`@ferrule/core`'s `ValueKind` naming, plus `"regex"`) to the
 *  language's own type name, e.g. `"integer"` -> `"int"`, `"boolean"` -> `"bool"`. */
function languageTypeName(kind: string): string {
  if (kind === 'integer') return 'int';
  if (kind === 'boolean') return 'bool';
  return kind;
}

function registerIsKind(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
  name: string,
  kindName: string,
  registerSignature: boolean,
): void {
  if (registerSignature) {
    registry.register(
      fn(
        name,
        [param('value', anyType)],
        boolType,
        'never',
        true,
        `Returns true if the value is ${article(kindName)} \`${kindName}\`.`,
        [`if ${name}(.value) { ... }`],
      ),
    );
  }
  impls?.register(impl(name, (args) => matchesKindName(kindName, args.positional[0] ?? null)));
}

function article(kindName: string): string {
  return /^[aeiou]/.test(kindName) ? 'an' : 'a';
}

function toIntValue(v: RuntimeValue): RuntimeValue | Failure {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return new Failure(`cannot convert ${v} to int: not finite`);
    const truncated = BigInt(Math.trunc(v));
    if (!isInt64(truncated)) return new Failure(`${v} is out of int64 range`);
    return truncated;
  }
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return new Failure(`cannot parse ${JSON.stringify(v)} as an int`);
    }
    let n: bigint;
    try {
      n = BigInt(trimmed);
    } catch {
      return new Failure(`cannot parse ${JSON.stringify(v)} as an int`);
    }
    if (!isInt64(n)) return new Failure(`${trimmed} is out of int64 range`);
    return n;
  }
  return new Failure(`cannot convert ${describeKind(v)} to int`);
}

function toFloatValue(v: RuntimeValue): RuntimeValue | Failure {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length === 0 || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
      return new Failure(`cannot parse ${JSON.stringify(v)} as a float`);
    }
    const n = Number(trimmed);
    if (Number.isNaN(n)) return new Failure(`cannot parse ${JSON.stringify(v)} as a float`);
    return n;
  }
  return new Failure(`cannot convert ${describeKind(v)} to float`);
}

const TRUE_WORDS = new Set(['true', 'yes', '1']);
const FALSE_WORDS = new Set(['false', 'no', '0']);

function toBoolValue(v: RuntimeValue): RuntimeValue | Failure {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (TRUE_WORDS.has(lower)) return true;
    if (FALSE_WORDS.has(lower)) return false;
    return new Failure(`cannot parse ${JSON.stringify(v)} as a bool`);
  }
  return new Failure(`cannot convert ${describeKind(v)} to bool`);
}

function toTimestampValue(v: RuntimeValue): RuntimeValue | Failure {
  if (v instanceof Timestamp) return v;
  if (typeof v === 'string') {
    const t = Timestamp.tryParse(v);
    return t ?? new Failure(`cannot parse ${JSON.stringify(v)} as an RFC 3339 timestamp`);
  }
  if (typeof v === 'bigint') return Timestamp.fromSeconds(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return new Failure(`cannot convert ${v} to timestamp: not finite`);
    return Timestamp.fromSeconds(v);
  }
  return new Failure(`cannot convert ${describeKind(v)} to timestamp`);
}

function describeKind(v: RuntimeValue): string {
  return isRegexValue(v) ? 'regex' : scriptKindOf(v);
}
