import { anyType, objectType, typeFromKindName, type Type } from '@ferrule/script';

/**
 * The `script` transform's `input_schema` option is a simple declarative field → type map (not
 * Ferrule Script's full type syntax): `{ status: int, message: string }`. Every name here is one
 * `@ferrule/script` accepts from `typeFromKindName` — see design.md §3/§4 and the script
 * package's `types/types.ts`.
 */
export const FIELD_KIND_NAMES = [
  'null',
  'bool',
  'int',
  'float',
  'string',
  'bytes',
  'timestamp',
  'array',
  'object',
  'any',
] as const;

export type FieldKindName = (typeof FIELD_KIND_NAMES)[number];

/**
 * Converts a flat field → kind-name map into a Ferrule object type, for `check(source, {
 * inputSchema })`. Fields not listed stay `any` (an open `rest` type), matching design.md §3's
 * default of "every unlisted path is `any`". This is intentionally flat: there is no nested
 * object/array element typing here, only the top-level field's own kind (`array`/`object` name
 * a fully open array/object, per `typeFromKindName`) — a person who needs precise nested typing
 * writes the input schema as a real Ferrule Script type today via a future `type` option, which
 * is a documented known gap.
 */
export function inputSchemaType(
  fields: ReadonlyMap<string, FieldKindName> | undefined,
): Type | undefined {
  if (fields === undefined || fields.size === 0) return undefined;
  const map = new Map<string, Type>();
  for (const [name, kind] of fields) {
    map.set(name, kind === 'any' ? anyType : (typeFromKindName(kind) ?? anyType));
  }
  return objectType(map, anyType);
}
