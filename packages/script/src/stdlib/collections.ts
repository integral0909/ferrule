import { compareValues, formatPath, type Value } from '@ferrule/core';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import type { RuntimeValue } from '../runtime/context.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { checkCollectionSize } from '../runtime/limits.js';
import { runtimeEquals } from '../runtime/ops.js';
import { containsRegex } from '../runtime/regex.js';
import { getInValue, setInValue, toPathSegments } from '../runtime/valuePath.js';
import {
  anyArrayType,
  anyObjectType,
  anyType,
  arrayType,
  boolType,
  intType,
  stringType,
  unionType,
} from '../types/types.js';
import { fn } from './helpers.js';

/** A collection function's natural container type: elements/values may be any `RuntimeValue`
 *  (including a nested regex — collections are script-local, not automatically event data; see
 *  `runtime/context.ts`'s `RuntimeValue` doc). */
type RVMap = Map<string, RuntimeValue>;

/**
 * Collections: `keys`, `values`, `get`/`set` (path-array form, via `runtime/valuePath.ts`'s
 * `getInValue`/`setInValue`/`toPathSegments`), `merge`, `compact`, `flatten`, `unflatten`,
 * `map_keys`, `includes`, `append`, `push`, `unique`, `sort`, `chunks`, `zip`. `length`,
 * `map_values`, `filter` are implemented in `stdlib/core.ts`; `del(.path)`/`exists(.path)` are
 * compiled as intrinsics by `compile/compiler.ts` (they need the *syntactic* path, not a runtime
 * value) and take no entry in `ImplementationRegistry` at all.
 */
export function registerCollections(
  registry: FunctionRegistry,
  impls?: ImplementationRegistry,
): void {
  const pathArrayType = arrayType(unionType([stringType, intType]));

  registry.register(
    fn(
      'keys',
      [param('value', anyObjectType)],
      arrayType(stringType),
      'on-argument-mismatch',
      true,
      "Returns an object's field names as an array, in insertion order.",
      ['keys(.headers)'],
    ),
  );
  impls?.register(
    impl('keys', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (!(v instanceof Map)) {
        return new Failure(`keys requires an object, found ${scriptKindOf(v)}`);
      }
      const out = [...v.keys()];
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'values',
      [param('value', anyObjectType)],
      anyArrayType,
      'on-argument-mismatch',
      true,
      "Returns an object's field values as an array, in insertion order.",
      ['values(.headers)'],
    ),
  );
  impls?.register(
    impl('values', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (!(v instanceof Map)) {
        return new Failure(`values requires an object, found ${scriptKindOf(v)}`);
      }
      const out = [...v.values()];
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'get',
      [
        param('value', anyType, { doc: 'the value to read from' }),
        param('path', pathArrayType, {
          doc: 'a path array of string field names and/or int indices',
        }),
      ],
      anyType,
      'always',
      true,
      'Reads a value at a runtime path array (`["a", 0, "b"]`), like `.a[0].b` but with a path built at ' +
        'run time. Fails if the path array is malformed or nothing exists at that path.',
      ['get(.event, ["user", "id"])!'],
    ),
  );
  impls?.register(
    impl('get', (args) => {
      const root = args.positional[0] ?? null;
      const pathArg = args.positional[1] ?? null;
      if (!Array.isArray(pathArg)) {
        return new Failure(`get requires a path array, found ${scriptKindOf(pathArg)}`);
      }
      const segments = toPathSegments(pathArg as Value);
      if (segments === undefined) {
        return new Failure('get: path array must contain only strings and ints');
      }
      if (segments.length === 0) return root;
      const result = getInValue(root as Value, segments);
      return result === undefined
        ? new Failure(`get: no value at path ${formatPath(segments)}`)
        : result;
    }),
  );

  registry.register(
    fn(
      'set',
      [
        param('value', anyType, { doc: 'the value to write into' }),
        param('path', pathArrayType, {
          doc: 'a path array of string field names and/or int indices',
        }),
        param('new_value', anyType, { doc: 'the value to write' }),
      ],
      anyType,
      'always',
      true,
      'Writes a value at a runtime path array, creating intermediate objects/arrays as needed, and ' +
        'returns the (possibly new) root. Fails if the path array is malformed.',
      ['let event = set(.event, ["user", "id"], 42)!'],
    ),
  );
  impls?.register(
    impl('set', (args) => {
      const root = args.positional[0] ?? null;
      const pathArg = args.positional[1] ?? null;
      const newValue = args.positional[2] ?? null;
      if (!Array.isArray(pathArg)) {
        return new Failure(`set requires a path array, found ${scriptKindOf(pathArg)}`);
      }
      const segments = toPathSegments(pathArg as Value);
      if (segments === undefined) {
        return new Failure('set: path array must contain only strings and ints');
      }
      if (segments.length === 0) return newValue;
      return setInValue(root as Value, segments, newValue as Value);
    }),
  );

  registry.register(
    fn(
      'merge',
      [
        param('a', anyObjectType),
        param('b', anyObjectType, { doc: "overwrites a's fields on conflict" }),
        param('deep', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      anyObjectType,
      'always',
      true,
      "Merges two objects into a new one. Shallow by default (`b`'s fields overwrite `a`'s); with " +
        '`deep: true`, fields present as objects on both sides are merged recursively instead of ' +
        'overwritten. Never mutates `a` or `b`.',
      ['merge(.defaults, .overrides)!', 'merge(.defaults, .overrides, deep: true)!'],
    ),
  );
  impls?.register(
    impl('merge', (args, ctx, span) => {
      const a = args.positional[0] ?? null;
      const b = args.positional[1] ?? null;
      if (!(a instanceof Map) || !(b instanceof Map)) {
        return new Failure(
          `merge requires two objects, found ${scriptKindOf(a)} and ${scriptKindOf(b)}`,
        );
      }
      const deep = args.named.get('deep') === true;
      const result = deep ? deepMerge(a, b, 0) : shallowMerge(a, b);
      if (result instanceof Failure) return result;
      checkCollectionSize(result.size, ctx.limits, span);
      return result;
    }),
  );

  registry.register(
    fn(
      'compact',
      [
        param('value', unionType([anyArrayType, anyObjectType])),
        param('remove_null', boolType, { optional: true, namedOnly: true, defaultDoc: 'true' }),
        param('remove_empty', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      (argTypes) => argTypes[0]?.type ?? anyType,
      'on-argument-mismatch',
      true,
      'Removes elements/fields from an array or object. By default drops `null` values; with ' +
        '`remove_empty: true` also drops empty strings, arrays, and objects.',
      ['compact(.fields)!', 'compact(.fields, remove_empty: true)!'],
    ),
  );
  impls?.register(
    impl('compact', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const removeNull = args.named.get('remove_null') !== false;
      const removeEmpty = args.named.get('remove_empty') === true;
      const shouldDrop = (x: RuntimeValue): boolean =>
        (removeNull && x === null) || (removeEmpty && isEmptyValue(x));
      if (Array.isArray(v)) {
        const out = v.filter((el) => !shouldDrop(el));
        checkCollectionSize(out.length, ctx.limits, span);
        return out;
      }
      if (v instanceof Map) {
        const out: RVMap = new Map();
        for (const [k, val] of v) if (!shouldDrop(val)) out.set(k, val);
        checkCollectionSize(out.size, ctx.limits, span);
        return out;
      }
      return new Failure(`compact requires an array or object, found ${scriptKindOf(v)}`);
    }),
  );

  registry.register(
    fn(
      'flatten',
      [
        param('value', anyObjectType),
        param('separator', stringType, { optional: true, namedOnly: true, defaultDoc: '"."' }),
      ],
      anyObjectType,
      'always',
      true,
      'Recursively flattens a nested object into a single-level object whose keys are the original ' +
        'paths joined by `separator` (e.g. `{"a": {"b": 1}}` becomes `{"a.b": 1}`). Arrays are treated ' +
        'as leaves and are not flattened further. An empty nested object becomes a leaf mapped to `{}`.',
      ['flatten(.event)!'],
    ),
  );
  impls?.register(
    impl('flatten', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (!(v instanceof Map)) {
        return new Failure(`flatten requires an object, found ${scriptKindOf(v)}`);
      }
      const separatorArg = args.named.get('separator');
      const separator = typeof separatorArg === 'string' ? separatorArg : '.';
      const out: RVMap = new Map();
      const result = flattenInto(v, '', separator, 0, out);
      if (result instanceof Failure) return result;
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'unflatten',
      [
        param('value', anyObjectType),
        param('separator', stringType, { optional: true, namedOnly: true, defaultDoc: '"."' }),
      ],
      anyObjectType,
      'always',
      true,
      'The inverse of `flatten`: splits each key on `separator` and rebuilds nested objects. Fails if ' +
        'a key\'s path conflicts with an already-built value (e.g. both `"a"` and `"a.b"` present).',
      ['unflatten(.flat_event)!'],
    ),
  );
  impls?.register(
    impl('unflatten', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (!(v instanceof Map)) {
        return new Failure(`unflatten requires an object, found ${scriptKindOf(v)}`);
      }
      const separatorArg = args.named.get('separator');
      const separator = typeof separatorArg === 'string' ? separatorArg : '.';
      const out: RVMap = new Map();
      for (const [flatKey, val] of v) {
        const parts = separator.length === 0 ? [flatKey] : flatKey.split(separator);
        let container = out;
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i]!;
          const existing = container.get(part);
          if (existing === undefined) {
            const next: RVMap = new Map();
            container.set(part, next);
            container = next;
          } else if (existing instanceof Map) {
            container = existing;
          } else {
            return new Failure(
              `unflatten: key ${JSON.stringify(flatKey)} conflicts with an existing value at ${JSON.stringify(part)}`,
            );
          }
        }
        const lastPart = parts[parts.length - 1]!;
        if (container.get(lastPart) instanceof Map) {
          return new Failure(
            `unflatten: key ${JSON.stringify(flatKey)} conflicts with an existing nested object at ${JSON.stringify(lastPart)}`,
          );
        }
        container.set(lastPart, val);
      }
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'map_keys',
      [
        param('input', anyObjectType),
        param('fn', anyType, {
          closure: {
            params: [
              { name: 'key', type: stringType },
              { name: 'value', type: anyType },
            ],
          },
          doc: 'called with each field name and value; its result replaces the key',
        }),
      ],
      anyObjectType,
      'always',
      true,
      'Builds a new object by applying a closure to every field name of an object, keeping each ' +
        'value. The closure must return a string. If two fields map to the same new key, the later ' +
        'one (in iteration order) wins.',
      ['map_keys(.headers, |k, v| upcase(k) ?? k)!'],
    ),
  );
  impls?.register(
    impl('map_keys', (args, ctx, span) => {
      const input = args.positional[0] ?? null;
      const mapFn = args.closures[0];
      if (!(input instanceof Map) || mapFn === undefined) {
        return new Failure(`map_keys requires an object, found ${scriptKindOf(input)}`);
      }
      const out: RVMap = new Map();
      for (const [k, v] of input) {
        const result = mapFn([k, v], ctx);
        if (result instanceof Failure) return result;
        if (typeof result !== 'string') {
          return new Failure(
            `map_keys: closure must return a string, found ${scriptKindOf(result)}`,
          );
        }
        out.set(result, v);
      }
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'includes',
      [param('value', anyArrayType), param('element', anyType)],
      boolType,
      'on-argument-mismatch',
      true,
      'Returns true if `element` structurally equals any element of `value`.',
      ['includes(.tags, "prod")'],
    ),
  );
  impls?.register(
    impl('includes', (args) => {
      const v = args.positional[0] ?? null;
      const element = args.positional[1] ?? null;
      if (!Array.isArray(v)) {
        return new Failure(`includes requires an array, found ${scriptKindOf(v)}`);
      }
      return v.some((el) => runtimeEquals(el, element));
    }),
  );

  registry.register(
    fn(
      'append',
      [param('value', anyArrayType), param('other', anyArrayType)],
      anyArrayType,
      'on-argument-mismatch',
      true,
      'Concatenates two arrays into a new array. Does not mutate either input.',
      ['append(.a, .b)!'],
    ),
  );
  impls?.register(
    impl('append', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const other = args.positional[1] ?? null;
      if (!Array.isArray(v) || !Array.isArray(other)) {
        return new Failure(
          `append requires two arrays, found ${scriptKindOf(v)} and ${scriptKindOf(other)}`,
        );
      }
      const out = [...v, ...other];
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'push',
      [param('value', anyArrayType), param('element', anyType)],
      anyArrayType,
      'on-argument-mismatch',
      true,
      'Returns a new array with `element` appended. Ferrule Script arrays are immutable, so this does ' +
        'not modify `value`.',
      ['.tags = push(.tags, "new")!'],
    ),
  );
  impls?.register(
    impl('push', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const element = args.positional[1] ?? null;
      if (!Array.isArray(v)) return new Failure(`push requires an array, found ${scriptKindOf(v)}`);
      const out: RuntimeValue[] = [...v, element];
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'unique',
      [param('value', anyArrayType)],
      anyArrayType,
      'on-argument-mismatch',
      true,
      'Removes duplicate elements (by structural equality), keeping the first occurrence and ' +
        'preserving order. O(n²) in the length of `value`.',
      ['unique(.tags)!'],
    ),
  );
  impls?.register(
    impl('unique', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (!Array.isArray(v)) {
        return new Failure(`unique requires an array, found ${scriptKindOf(v)}`);
      }
      const out: RuntimeValue[] = [];
      for (const el of v) {
        if (!out.some((existing) => runtimeEquals(existing, el))) out.push(el);
      }
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'sort',
      [
        param('value', anyArrayType),
        param('descending', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      anyArrayType,
      'always',
      true,
      'Returns a new array sorted by natural order (nulls first, then bools, ints/floats compared ' +
        'numerically, strings/bytes lexicographically, timestamps chronologically, arrays/objects ' +
        'element-wise). Fails if any element is a regex, which has no defined order.',
      ['sort(.scores)!', 'sort(.scores, descending: true)!'],
    ),
  );
  impls?.register(
    impl('sort', (args) => {
      const v = args.positional[0] ?? null;
      if (!Array.isArray(v)) return new Failure(`sort requires an array, found ${scriptKindOf(v)}`);
      for (const el of v) {
        if (containsRegex(el)) return new Failure('sort: cannot sort a regex value');
      }
      const descending = args.named.get('descending') === true;
      const values = v as Value[];
      return values
        .slice()
        .sort((x, y) => (descending ? compareValues(y, x) : compareValues(x, y)));
    }),
  );

  registry.register(
    fn(
      'chunks',
      [param('value', anyArrayType), param('size', intType)],
      arrayType(anyArrayType),
      'always',
      true,
      'Splits `value` into consecutive chunks of `size` elements (the last chunk may be shorter). ' +
        'Fails if `size` is less than 1.',
      ['chunks(.items, 100)!'],
    ),
  );
  impls?.register(
    impl('chunks', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const sizeArg = args.positional[1] ?? null;
      if (!Array.isArray(v)) {
        return new Failure(`chunks requires an array, found ${scriptKindOf(v)}`);
      }
      if (typeof sizeArg !== 'bigint') {
        return new Failure(`chunks requires an int size, found ${scriptKindOf(sizeArg)}`);
      }
      const size = Number(sizeArg);
      if (size < 1) return new Failure(`chunks: size must be at least 1, found ${size}`);
      const out: RuntimeValue[][] = [];
      for (let i = 0; i < v.length; i += size) out.push(v.slice(i, i + size));
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );

  registry.register(
    fn(
      'zip',
      [param('a', anyArrayType), param('b', anyArrayType)],
      arrayType(anyArrayType),
      'on-argument-mismatch',
      true,
      'Pairs up elements of `a` and `b` into `[a[i], b[i]]` 2-element arrays, up to the length of the ' +
        'shorter array.',
      ['zip(.names, .ids)!'],
    ),
  );
  impls?.register(
    impl('zip', (args, ctx, span) => {
      const a = args.positional[0] ?? null;
      const b = args.positional[1] ?? null;
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return new Failure(
          `zip requires two arrays, found ${scriptKindOf(a)} and ${scriptKindOf(b)}`,
        );
      }
      const length = Math.min(a.length, b.length);
      const out: RuntimeValue[][] = [];
      for (let i = 0; i < length; i++) out.push([a[i]!, b[i]!]);
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );
}

function isEmptyValue(x: RuntimeValue): boolean {
  if (typeof x === 'string') return x.length === 0;
  if (Array.isArray(x)) return x.length === 0;
  if (x instanceof Map) return x.size === 0;
  return false;
}

const MAX_MERGE_DEPTH = 64;

function shallowMerge(a: RVMap, b: RVMap): RVMap {
  const out: RVMap = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

function deepMerge(a: RVMap, b: RVMap, depth: number): RVMap | Failure {
  if (depth > MAX_MERGE_DEPTH) {
    return new Failure(`merge: exceeded maximum nesting depth (${MAX_MERGE_DEPTH})`);
  }
  const out: RVMap = new Map(a);
  for (const [k, bv] of b) {
    const av = out.get(k);
    if (av instanceof Map && bv instanceof Map) {
      const merged = deepMerge(av, bv, depth + 1);
      if (merged instanceof Failure) return merged;
      out.set(k, merged);
    } else {
      out.set(k, bv);
    }
  }
  return out;
}

const MAX_FLATTEN_DEPTH = 64;

function flattenInto(
  obj: RVMap,
  prefix: string,
  separator: string,
  depth: number,
  out: RVMap,
): Failure | undefined {
  if (depth > MAX_FLATTEN_DEPTH) {
    return new Failure(`flatten: exceeded maximum nesting depth (${MAX_FLATTEN_DEPTH})`);
  }
  for (const [k, v] of obj) {
    const key = prefix === '' ? k : `${prefix}${separator}${k}`;
    if (v instanceof Map && v.size > 0) {
      const result = flattenInto(v, key, separator, depth + 1, out);
      if (result instanceof Failure) return result;
    } else {
      out.set(key, v);
    }
  }
  return undefined;
}
