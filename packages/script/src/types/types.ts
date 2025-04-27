/**
 * Ferrule Script's static type system (design.md §3).
 *
 * A {@link Type} always describes a value that exists — it never carries fallibility.
 * Fallibility (`T!`) is a property of an *expression*, not of a type, and is represented
 * separately by {@link ExprType} so that `array<T>` element types, object field types, and
 * function parameter/return types never need to reason about `T!` themselves (design.md §5:
 * handling `??`/`!`/error-capture removes the `!` and leaves a plain `T`).
 */

export type TypeKind =
  | 'null'
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'bytes'
  | 'timestamp'
  | 'regex'
  | 'array'
  | 'object'
  | 'union'
  | 'any'
  | 'never';

interface SimpleType {
  readonly kind:
    | 'null'
    | 'bool'
    | 'int'
    | 'float'
    | 'string'
    | 'bytes'
    | 'timestamp'
    | 'regex'
    | 'any'
    | 'never';
}

export interface ArrayType {
  readonly kind: 'array';
  readonly element: Type;
}

/**
 * An object shape. `fields` are the known fields. `rest` describes fields not listed: `undefined`
 * means the shape is closed (accessing an unlisted field is a type error); a {@link Type} means
 * the shape is open and unlisted fields have that type (`any` for "anything goes").
 */
export interface ObjectType {
  readonly kind: 'object';
  readonly fields: ReadonlyMap<string, Type>;
  readonly rest: Type | undefined;
}

/** Always has at least two members; never contains another union or `never` (see {@link unionType}). */
export interface UnionType {
  readonly kind: 'union';
  readonly members: readonly Type[];
}

export type Type = SimpleType | ArrayType | ObjectType | UnionType;

/** An expression's type together with whether it is fallible (`T` vs `T!`, design.md §5). */
export interface ExprType {
  readonly type: Type;
  readonly fallible: boolean;
}

export function handled(type: Type): ExprType {
  return { type, fallible: false };
}

export function fallibleOf(type: Type): ExprType {
  return { type, fallible: true };
}

export function withFallibility(exprType: ExprType, fallible: boolean): ExprType {
  return fallible === exprType.fallible ? exprType : { type: exprType.type, fallible };
}

// ---- constructors -------------------------------------------------------------------------

export const nullType: Type = { kind: 'null' };
export const boolType: Type = { kind: 'bool' };
export const intType: Type = { kind: 'int' };
export const floatType: Type = { kind: 'float' };
export const stringType: Type = { kind: 'string' };
export const bytesType: Type = { kind: 'bytes' };
export const timestampType: Type = { kind: 'timestamp' };
export const regexType: Type = { kind: 'regex' };
export const anyType: Type = { kind: 'any' };
export const neverType: Type = { kind: 'never' };

export function arrayType(element: Type): Type {
  return { kind: 'array', element };
}

/** A fully open array of unknown element type: `array<any>`. */
export const anyArrayType: Type = arrayType(anyType);

export function objectType(
  fields: Readonly<Record<string, Type>> | ReadonlyMap<string, Type>,
  rest?: Type,
): Type {
  const map = fields instanceof Map ? fields : new Map(Object.entries(fields));
  return { kind: 'object', fields: map, rest };
}

/** A fully open object of unknown shape: `object { ..any }`. */
export const anyObjectType: Type = objectType({}, anyType);

/**
 * Builds a normalized union: flattens nested unions, drops `never`, collapses to `any` if any
 * member is `any`, deduplicates structurally equal members, and unwraps a single-member result.
 */
export function unionType(members: readonly Type[]): Type {
  const flat: Type[] = [];
  const flatten = (t: Type): void => {
    if (t.kind === 'union') t.members.forEach(flatten);
    else if (t.kind !== 'never') flat.push(t);
  };
  members.forEach(flatten);
  if (flat.some((t) => t.kind === 'any')) return anyType;
  const unique: Type[] = [];
  for (const t of flat) {
    if (!unique.some((u) => typesEqual(u, t))) unique.push(t);
  }
  if (unique.length === 0) return neverType;
  if (unique.length === 1) return unique[0]!;
  return { kind: 'union', members: unique };
}

/** Maps a `match`/`is` kind-pattern name (design.md §4) to the type it tests for. */
export function typeFromKindName(name: string): Type | undefined {
  switch (name) {
    case 'null':
      return nullType;
    case 'bool':
      return boolType;
    case 'int':
      return intType;
    case 'float':
      return floatType;
    case 'string':
      return stringType;
    case 'bytes':
      return bytesType;
    case 'timestamp':
      return timestampType;
    case 'regex':
      return regexType;
    case 'array':
      return anyArrayType;
    case 'object':
      return anyObjectType;
    default:
      return undefined;
  }
}

// ---- equality, subtyping, join/meet ---------------------------------------------------------

export function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'array':
      return typesEqual(a.element, (b as ArrayType).element);
    case 'object': {
      const bo = b as ObjectType;
      if (a.fields.size !== bo.fields.size) return false;
      if ((a.rest === undefined) !== (bo.rest === undefined)) return false;
      if (a.rest !== undefined && bo.rest !== undefined && !typesEqual(a.rest, bo.rest)) {
        return false;
      }
      for (const [k, t] of a.fields) {
        const bt = bo.fields.get(k);
        if (bt === undefined || !typesEqual(t, bt)) return false;
      }
      return true;
    }
    case 'union': {
      const bu = (b as UnionType).members;
      if (a.members.length !== bu.length) return false;
      return a.members.every((m) => bu.some((n) => typesEqual(m, n)));
    }
    default:
      return true;
  }
}

/**
 * Structural subtyping. `any` is compatible with everything in both directions (this is a
 * gradually typed boundary, matching design.md §3's "paths... have type `any`" escape hatch, not
 * unsound covariance elsewhere). `never` is a subtype of everything. Objects use width-and-depth
 * subtyping: `a` may have extra fields beyond what `b` requires.
 */
export function isSubtype(a: Type, b: Type): boolean {
  if (a.kind === 'any' || b.kind === 'any') return true;
  if (a.kind === 'never') return true;
  if (b.kind === 'never') return false;
  if (a.kind === 'union') return a.members.every((m) => isSubtype(m, b));
  if (b.kind === 'union') return b.members.some((m) => isSubtype(a, m));
  if (a.kind === 'array' && b.kind === 'array') return isSubtype(a.element, b.element);
  if (a.kind === 'object' && b.kind === 'object') {
    for (const [k, bt] of b.fields) {
      const at = a.fields.get(k) ?? a.rest;
      if (at === undefined || !isSubtype(at, bt)) return false;
    }
    if (b.rest !== undefined) {
      for (const [k, at] of a.fields) {
        if (!b.fields.has(k) && !isSubtype(at, b.rest)) return false;
      }
      if (a.rest !== undefined && !isSubtype(a.rest, b.rest)) return false;
    }
    return true;
  }
  return a.kind === b.kind;
}

/** The least upper bound: the narrowest type both `a` and `b` are subtypes of. */
export function joinTypes(a: Type, b: Type): Type {
  if (typesEqual(a, b)) return a;
  if (a.kind === 'never') return b;
  if (b.kind === 'never') return a;
  if (a.kind === 'any' || b.kind === 'any') return anyType;
  return unionType([a, b]);
}

/**
 * An approximation of the greatest lower bound, used for flow narrowing (e.g. `.x is string`
 * narrows an `any`/union-typed `.x` to `string` on the true branch). Not a general lattice meet:
 * for two unrelated concrete types it returns `never` (the narrowing is unreachable).
 */
export function meetTypes(a: Type, b: Type): Type {
  if (typesEqual(a, b)) return a;
  if (a.kind === 'any') return b;
  if (b.kind === 'any') return a;
  if (a.kind === 'never' || b.kind === 'never') return neverType;
  if (a.kind === 'union') return unionType(a.members.map((m) => meetTypes(m, b)));
  if (b.kind === 'union') return unionType(b.members.map((m) => meetTypes(a, m)));
  if (isSubtype(a, b)) return a;
  if (isSubtype(b, a)) return b;
  return neverType;
}

/** Removes `remove` from `from`'s members, for narrowing the false/else branch of a type test. */
export function subtractType(from: Type, remove: Type): Type {
  if (from.kind === 'any') return anyType; // cannot narrow `any` by exclusion alone
  if (typesEqual(from, remove)) return neverType;
  if (from.kind === 'union') {
    return unionType(from.members.filter((m) => !typesEqual(m, remove) && !isSubtype(m, remove)));
  }
  return from;
}

// ---- pretty printing ------------------------------------------------------------------------

export function formatType(type: Type): string {
  switch (type.kind) {
    case 'array':
      return `array<${formatType(type.element)}>`;
    case 'object': {
      const parts = [...type.fields].map(([k, t]) => `${formatFieldKey(k)}: ${formatType(t)}`);
      if (type.rest !== undefined) parts.push(`..${formatType(type.rest)}`);
      return parts.length === 0 ? 'object {}' : `object { ${parts.join(', ')} }`;
    }
    case 'union':
      return type.members.map(formatType).join(' | ');
    default:
      return type.kind;
  }
}

export function formatExprType(exprType: ExprType): string {
  const base = formatType(exprType.type);
  return exprType.fallible ? `${base}!` : base;
}

const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function formatFieldKey(key: string): string {
  return SIMPLE_KEY.test(key) ? key : JSON.stringify(key);
}
