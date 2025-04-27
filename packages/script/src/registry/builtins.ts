import {
  anyArrayType,
  anyObjectType,
  anyType,
  arrayType,
  boolType,
  bytesType,
  intType,
  nullType,
  objectType,
  regexType,
  stringType,
  timestampType,
  unionType,
} from '../types/types.js';
import { FunctionRegistry, param, type FunctionSignature } from './signature.js';

function fn(
  name: string,
  params: FunctionSignature['params'],
  returnType: FunctionSignature['returnType'],
  fallible: FunctionSignature['fallible'],
  pure: boolean,
  docs: string,
  examples: readonly string[] = [],
): FunctionSignature {
  return { name, params, returnType, fallible, pure, docs, examples };
}

/**
 * The subset of the Ferrule Script standard library needed to exercise the checker end to end.
 * Only signatures are declared here — implementations belong to a later milestone (the compiler
 * and runtime), per the front end/back end split in docs/architecture.md.
 */
export function registerBuiltins(registry: FunctionRegistry): FunctionRegistry {
  registry.register(
    fn(
      'to_int',
      [param('value', anyType, { doc: 'the value to convert' })],
      intType,
      'always',
      true,
      'Converts a value to an integer. Fails if the value cannot be interpreted as an integer.',
      ['to_int(.status_code) ?? 0', 'to_int("42")!'],
    ),
  );

  registry.register(
    fn(
      'to_string',
      [param('value', anyType, { doc: 'the value to render' })],
      stringType,
      'never',
      true,
      'Renders any value as its Ferrule Script literal string form. Never fails.',
      ['to_string(.count)'],
    ),
  );

  registry.register(
    fn(
      'upcase',
      [param('value', stringType)],
      stringType,
      'on-argument-mismatch',
      true,
      'Converts a string to upper case.',
      ['upcase(.level)'],
    ),
  );

  registry.register(
    fn(
      'downcase',
      [param('value', stringType)],
      stringType,
      'on-argument-mismatch',
      true,
      'Converts a string to lower case.',
      ['downcase(.level) ?? "info"'],
    ),
  );

  registry.register(
    fn(
      'parse_json',
      [param('text', stringType)],
      anyType,
      'always',
      true,
      'Parses a JSON document. Fails if the text is not valid JSON.',
      ['parse_json(.raw)!'],
    ),
  );

  registry.register(
    fn(
      'parse_regex',
      [
        param('pattern', stringType),
        param('flags', stringType, { optional: true, namedOnly: true, defaultDoc: '""' }),
      ],
      regexType,
      'always',
      true,
      'Compiles a string into a regex. Fails if the pattern is invalid.',
      ['parse_regex(.pattern, flags: "i")!'],
    ),
  );

  registry.register(
    fn(
      'is_string',
      [param('value', anyType)],
      boolType,
      'never',
      true,
      'Returns true if the value is a string.',
      ['if is_string(.status) { .status = upcase(.status) }'],
    ),
  );

  registry.register(
    fn(
      'is_int',
      [param('value', anyType)],
      boolType,
      'never',
      true,
      'Returns true if the value is an integer.',
    ),
  );

  registry.register(
    fn(
      'length',
      [param('value', unionType([stringType, bytesType, anyArrayType, anyObjectType]))],
      intType,
      'on-argument-mismatch',
      true,
      'Returns the length of a string (in UTF-16 code units), byte string, array, or object.',
      ['length(.items)'],
    ),
  );

  registry.register(
    fn(
      'del',
      [param('path', anyType, { requiresPathArgument: true, doc: 'the field to remove' })],
      anyType,
      'never',
      false,
      'Removes a field and returns its previous value, or `null` if it was absent.',
      ['del(.debug)'],
    ),
  );

  registry.register(
    fn(
      'exists',
      [param('path', anyType, { requiresPathArgument: true, doc: 'the field to test' })],
      boolType,
      'never',
      true,
      'Returns true if a field is present.',
      ['if exists(.trace_id) { ... }'],
    ),
  );

  registry.register(
    fn(
      'map_values',
      [
        param('input', anyObjectType),
        param('fn', anyType, {
          closure: {
            params: [
              { name: 'key', type: stringType },
              { name: 'value', type: anyType },
            ],
          },
          doc: 'called with each field name and value; its result replaces the value',
        }),
      ],
      (argTypes, ctx) => objectType({}, ctx.closureReturn?.type ?? anyType),
      'on-argument-mismatch',
      true,
      'Builds a new object by applying a closure to every field of an object.',
      ['map_values(.headers, |k, v| downcase(v) ?? v)'],
    ),
  );

  registry.register(
    fn(
      'filter',
      [
        param('input', anyArrayType),
        param('fn', anyType, {
          closure: { params: [{ name: 'value', type: anyType }] },
          doc: 'called with each element; kept when it returns true',
        }),
      ],
      (argTypes) => argTypes[0]?.type ?? anyArrayType,
      'on-argument-mismatch',
      true,
      'Builds a new array from the elements of an array for which a closure returns true.',
      ['filter(.tags, |t| is_string(t))'],
    ),
  );

  registry.register(
    fn('now', [], timestampType, 'never', false, 'Returns the current time.', ['let seen = now()']),
  );

  registry.register(
    fn(
      'emit',
      [param('event', anyType, { doc: 'an additional event to emit alongside this one' })],
      nullType,
      'never',
      false,
      'Emits an additional event, for splitting one event into many.',
      ['emit({ "kind": "child", "parent_id": .id })'],
    ),
  );

  return registry;
}

export function createDefaultRegistry(): FunctionRegistry {
  return registerBuiltins(new FunctionRegistry());
}

// Re-exported so callers building custom registries don't need a second import for basic shapes.
export { arrayType };
