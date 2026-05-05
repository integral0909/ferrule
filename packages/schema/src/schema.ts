import {
  closestMatch,
  describeInput,
  SchemaValidationError,
  type Issue,
  type IssueCode,
  type IssuePath,
} from './issues.js';

const INVALID: unique symbol = Symbol('invalid');
type Result<T> = T | typeof INVALID;

/** Accumulates issues while a value is validated. Validation never stops at the first issue. */
export class ParseContext {
  readonly issues: Issue[] = [];
  private readonly path: (string | number)[] = [];

  report(code: IssueCode, message: string, hint?: string): typeof INVALID {
    const issue: Issue = { path: [...this.path], code, message };
    if (hint !== undefined) issue.hint = hint;
    this.issues.push(issue);
    return INVALID;
  }

  /** Runs `fn` with `segment` appended to the current path. */
  at<T>(segment: string | number, fn: () => T): T {
    this.path.push(segment);
    try {
      return fn();
    } finally {
      this.path.pop();
    }
  }

  get currentPath(): IssuePath {
    return this.path;
  }
}

/** A serialisable description of a schema, used for generated docs, `ferrule validate`, and the LSP. */
export interface SchemaDoc {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  secret?: boolean;
  deprecated?: string;
  examples?: unknown[];
  constraints?: Record<string, unknown>;
  fields?: Record<string, SchemaDoc>;
  items?: SchemaDoc;
  values?: readonly unknown[];
  variants?: SchemaDoc[];
  discriminator?: string;
}

interface SchemaMeta {
  description?: string;
  secret?: boolean;
  deprecated?: string;
  examples?: unknown[];
}

export type SafeParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

/** The placeholder that {@link Schema.redact} substitutes for secret values. */
export const REDACTED = '**REDACTED**';

/**
 * Base class for all schemas. A schema validates untrusted configuration input (as produced by
 * the YAML/JSON loaders) and converts it into a typed options object.
 */
export abstract class Schema<Out> {
  /** Phantom field carrying the output type; never set at runtime. */
  declare readonly _output: Out;
  protected meta: SchemaMeta = {};

  /** @internal Validates `input`, reporting issues to `ctx`. */
  abstract check(input: unknown, ctx: ParseContext): Result<Out>;

  /** @internal The schema-specific part of {@link toDoc}. */
  protected abstract docBase(): SchemaDoc;

  /** Validates and converts `input`, throwing {@link SchemaValidationError} with every issue found. */
  parse(input: unknown): Out {
    const result = this.safeParse(input);
    if (!result.ok) throw new SchemaValidationError(result.issues);
    return result.value;
  }

  safeParse(input: unknown): SafeParseResult<Out> {
    const ctx = new ParseContext();
    const value = this.check(input, ctx);
    if (value === INVALID || ctx.issues.length > 0) return { ok: false, issues: ctx.issues };
    return { ok: true, value };
  }

  describe(description: string): this {
    return this.withMeta({ description });
  }

  /** Marks the value as secret: it is redacted by {@link redact} and flagged in docs. */
  secret(): this {
    return this.withMeta({ secret: true });
  }

  deprecated(reason: string): this {
    return this.withMeta({ deprecated: reason });
  }

  example(...examples: unknown[]): this {
    return this.withMeta({ examples: [...(this.meta.examples ?? []), ...examples] });
  }

  optional(): OptionalSchema<Out> {
    return new OptionalSchema(this);
  }

  /** Uses `value` when the input is missing. The output type no longer includes `undefined`. */
  default(value: Out): DefaultSchema<Out> {
    return new DefaultSchema(this, value);
  }

  /** Adds a check that runs after this schema succeeds. */
  refine(
    predicate: (value: Out) => boolean,
    message: string | ((value: Out) => string),
  ): Schema<Out> {
    return new EffectsSchema(this, (value, ctx) => {
      if (predicate(value)) return value;
      return ctx.report('custom', typeof message === 'string' ? message : message(value));
    });
  }

  /**
   * Converts the validated value. `fn` may call `ctx.report(...)` and return {@link invalid} to
   * reject the value with a precise message.
   */
  transform<T>(fn: (value: Out, ctx: ParseContext) => T | typeof INVALID): Schema<T> {
    return new EffectsSchema(this, fn);
  }

  get isSecret(): boolean {
    return this.meta.secret === true;
  }

  /**
   * Whether an object field using this schema may be omitted. True for optional and defaulted
   * schemas, and for refinements or transforms wrapped around them.
   */
  get acceptsMissing(): boolean {
    return false;
  }

  get description(): string | undefined {
    return this.meta.description;
  }

  toDoc(): SchemaDoc {
    const doc = this.docBase();
    if (this.meta.description !== undefined) doc.description = this.meta.description;
    if (this.meta.secret === true) doc.secret = true;
    if (this.meta.deprecated !== undefined) doc.deprecated = this.meta.deprecated;
    if (this.meta.examples !== undefined) doc.examples = [...this.meta.examples];
    return doc;
  }

  /**
   * Returns a copy of raw `input` with every value covered by a secret schema replaced by
   * {@link REDACTED}. Used before logging or displaying configuration.
   */
  redact(input: unknown): unknown {
    return this.isSecret && input !== undefined ? REDACTED : this.redactInner(input);
  }

  /** @internal Redacts nested values; containers override this. */
  protected redactInner(input: unknown): unknown {
    return input;
  }

  protected withMeta(meta: SchemaMeta): this {
    const copy = Object.create(Object.getPrototypeOf(this) as object) as this;
    Object.assign(copy, this);
    copy.meta = { ...this.meta, ...meta };
    return copy;
  }
}

/** The sentinel a {@link Schema.transform} callback returns after reporting an issue. */
export const invalid: typeof INVALID = INVALID;

export type Infer<S> = S extends Schema<infer O> ? O : never;

export class OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional = true;

  constructor(readonly inner: Schema<T>) {
    super();
  }

  override get acceptsMissing(): boolean {
    return true;
  }

  check(input: unknown, ctx: ParseContext): Result<T | undefined> {
    return input === undefined ? undefined : this.inner.check(input, ctx);
  }

  protected docBase(): SchemaDoc {
    return { ...this.inner.toDoc(), optional: true };
  }

  override redact(input: unknown): unknown {
    return this.isSecret && input !== undefined ? REDACTED : this.inner.redact(input);
  }
}

export class DefaultSchema<T> extends Schema<T> {
  constructor(
    readonly inner: Schema<T>,
    readonly defaultValue: T,
  ) {
    super();
  }

  override get acceptsMissing(): boolean {
    return true;
  }

  check(input: unknown, ctx: ParseContext): Result<T> {
    return input === undefined ? this.defaultValue : this.inner.check(input, ctx);
  }

  protected docBase(): SchemaDoc {
    return { ...this.inner.toDoc(), optional: true, default: this.defaultValue };
  }

  override redact(input: unknown): unknown {
    return this.isSecret && input !== undefined ? REDACTED : this.inner.redact(input);
  }
}

class EffectsSchema<In, Out> extends Schema<Out> {
  constructor(
    private readonly inner: Schema<In>,
    private readonly effect: (value: In, ctx: ParseContext) => Out | typeof INVALID,
  ) {
    super();
    this.meta = { ...(inner as EffectsSchema<unknown, In>).meta };
  }

  override get acceptsMissing(): boolean {
    return this.inner.acceptsMissing;
  }

  check(input: unknown, ctx: ParseContext): Result<Out> {
    const before = ctx.issues.length;
    const value = this.inner.check(input, ctx);
    if (value === INVALID || ctx.issues.length > before) return INVALID;
    // A missing optional value stays missing: refinements and transforms apply to present values.
    if (value === undefined && input === undefined && this.inner.acceptsMissing) {
      return undefined as Out;
    }
    return this.effect(value, ctx);
  }

  protected docBase(): SchemaDoc {
    return this.inner.toDoc();
  }

  override redact(input: unknown): unknown {
    return this.isSecret && input !== undefined ? REDACTED : this.inner.redact(input);
  }
}

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** Human description of `pattern` for error messages, e.g. "a lowercase identifier". */
  patternName?: string;
}

export class StringSchema extends Schema<string> {
  constructor(private readonly options: StringOptions = {}) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<string> {
    if (typeof input !== 'string') {
      return ctx.report('invalid_type', `expected a string, got ${describeInput(input)}`);
    }
    const { minLength, maxLength, pattern, patternName } = this.options;
    if (minLength !== undefined && input.length < minLength) {
      return ctx.report(
        'too_small',
        minLength === 1 ? 'must not be empty' : `must be at least ${minLength} characters`,
      );
    }
    if (maxLength !== undefined && input.length > maxLength) {
      return ctx.report('too_big', `must be at most ${maxLength} characters`);
    }
    if (pattern !== undefined && !pattern.test(input)) {
      return ctx.report(
        'invalid_string',
        `must be ${patternName ?? `a string matching ${String(pattern)}`}`,
      );
    }
    return input;
  }

  nonEmpty(): StringSchema {
    return new StringSchema({
      ...this.options,
      minLength: Math.max(1, this.options.minLength ?? 0),
    }).copyMeta(this);
  }

  private copyMeta(from: StringSchema): this {
    this.meta = { ...from.meta };
    return this;
  }

  protected docBase(): SchemaDoc {
    const constraints: Record<string, unknown> = {};
    if (this.options.minLength !== undefined) constraints['minLength'] = this.options.minLength;
    if (this.options.maxLength !== undefined) constraints['maxLength'] = this.options.maxLength;
    if (this.options.pattern !== undefined) constraints['pattern'] = this.options.pattern.source;
    return Object.keys(constraints).length > 0
      ? { type: 'string', constraints }
      : { type: 'string' };
  }
}

export interface NumberOptions {
  integer?: boolean;
  min?: number;
  max?: number;
  /** Exclusive lower bound (e.g. `> 0`). */
  greaterThan?: number;
}

export class NumberSchema extends Schema<number> {
  constructor(private readonly options: NumberOptions = {}) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<number> {
    let n: number;
    if (typeof input === 'number') n = input;
    else if (
      typeof input === 'bigint' &&
      input <= BigInt(Number.MAX_SAFE_INTEGER) &&
      input >= BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      n = Number(input);
    } else return ctx.report('invalid_type', `expected a number, got ${describeInput(input)}`);

    const { integer, min, max, greaterThan } = this.options;
    if (!Number.isFinite(n)) return ctx.report('invalid_type', 'expected a finite number');
    if (integer === true && !Number.isSafeInteger(n)) {
      return ctx.report('invalid_type', `expected an integer, got ${n}`);
    }
    if (min !== undefined && n < min) {
      return ctx.report('too_small', `must be at least ${min}, got ${n}`);
    }
    if (greaterThan !== undefined && n <= greaterThan) {
      return ctx.report('too_small', `must be greater than ${greaterThan}, got ${n}`);
    }
    if (max !== undefined && n > max) {
      return ctx.report('too_big', `must be at most ${max}, got ${n}`);
    }
    return n;
  }

  protected docBase(): SchemaDoc {
    const { integer, ...constraints } = this.options;
    const doc: SchemaDoc = { type: integer === true ? 'integer' : 'number' };
    if (Object.keys(constraints).length > 0) doc.constraints = { ...constraints };
    return doc;
  }
}

export class BooleanSchema extends Schema<boolean> {
  check(input: unknown, ctx: ParseContext): Result<boolean> {
    if (typeof input === 'boolean') return input;
    return ctx.report('invalid_type', `expected true or false, got ${describeInput(input)}`);
  }

  protected docBase(): SchemaDoc {
    return { type: 'boolean' };
  }
}

type Primitive = string | number | boolean | null;

export class LiteralSchema<T extends Primitive> extends Schema<T> {
  constructor(readonly value: T) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<T> {
    if (input === this.value) return this.value;
    return ctx.report(
      'invalid_enum',
      `expected ${JSON.stringify(this.value)}, got ${describeInput(input)}`,
    );
  }

  protected docBase(): SchemaDoc {
    return { type: 'literal', values: [this.value] };
  }
}

export class EnumSchema<T extends string> extends Schema<T> {
  constructor(readonly values: readonly T[]) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<T> {
    if (typeof input === 'string' && (this.values as readonly string[]).includes(input)) {
      return input as T;
    }
    const allowed = this.values.map((v) => JSON.stringify(v)).join(', ');
    const suggestion = typeof input === 'string' ? closestMatch(input, this.values) : undefined;
    return ctx.report(
      'invalid_enum',
      `expected one of ${allowed}, got ${typeof input === 'string' ? JSON.stringify(input) : describeInput(input)}`,
      suggestion === undefined ? undefined : `did you mean ${JSON.stringify(suggestion)}?`,
    );
  }

  protected docBase(): SchemaDoc {
    return { type: 'enum', values: [...this.values] };
  }
}

export class UnknownSchema extends Schema<unknown> {
  check(input: unknown): Result<unknown> {
    return input;
  }

  protected docBase(): SchemaDoc {
    return { type: 'any' };
  }
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

export interface ArrayOptions {
  minItems?: number;
  maxItems?: number;
  /** Accept a single item in place of a one-element array (`inputs: app` ≡ `inputs: [app]`). */
  acceptSingle?: boolean;
  /** Reject duplicate items (compared by JSON serialisation of the output). */
  unique?: boolean;
}

export class ArraySchema<T> extends Schema<T[]> {
  constructor(
    readonly item: Schema<T>,
    private readonly options: ArrayOptions = {},
  ) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<T[]> {
    let items: unknown[];
    if (Array.isArray(input)) items = input;
    else if (this.options.acceptSingle === true && input !== undefined && input !== null) {
      items = [input];
    } else return ctx.report('invalid_type', `expected an array, got ${describeInput(input)}`);

    const { minItems, maxItems, unique } = this.options;
    if (minItems !== undefined && items.length < minItems) {
      return ctx.report(
        'too_small',
        minItems === 1 ? 'must not be empty' : `must have at least ${minItems} items`,
      );
    }
    if (maxItems !== undefined && items.length > maxItems) {
      return ctx.report('too_big', `must have at most ${maxItems} items`);
    }
    const out: T[] = [];
    let failed = false;
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const value = ctx.at(i, () => this.item.check(item, ctx));
      if (value === INVALID) {
        failed = true;
        return;
      }
      if (unique === true) {
        const key = JSON.stringify(value, (_k, v: unknown) =>
          typeof v === 'bigint' ? v.toString() : v,
        );
        if (seen.has(key)) {
          ctx.at(i, () => ctx.report('custom', `duplicate item ${key}`));
          failed = true;
        }
        seen.add(key);
      }
      out.push(value);
    });
    return failed ? INVALID : out;
  }

  protected docBase(): SchemaDoc {
    const doc: SchemaDoc = { type: 'array', items: this.item.toDoc() };
    const { minItems, maxItems, unique } = this.options;
    const constraints: Record<string, unknown> = {};
    if (minItems !== undefined) constraints['minItems'] = minItems;
    if (maxItems !== undefined) constraints['maxItems'] = maxItems;
    if (unique === true) constraints['unique'] = true;
    if (Object.keys(constraints).length > 0) doc.constraints = constraints;
    return doc;
  }

  protected override redactInner(input: unknown): unknown {
    return Array.isArray(input) ? input.map((item) => this.item.redact(item)) : input;
  }
}

export type Shape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type ObjectOutput<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

export type UnknownKeys = 'reject' | 'strip' | 'passthrough';

/** True for a plain configuration object (not an array, not null). */
export function isPlainObject(input: unknown): input is Record<string, unknown> {
  return (
    typeof input === 'object' && input !== null && !Array.isArray(input) && !(input instanceof Map)
  );
}

export class ObjectSchema<S extends Shape> extends Schema<ObjectOutput<S>> {
  constructor(
    readonly shape: S,
    private readonly unknownKeys: UnknownKeys = 'reject',
  ) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<ObjectOutput<S>> {
    if (!isPlainObject(input)) {
      return ctx.report('invalid_type', `expected an object, got ${describeInput(input)}`);
    }
    // Build with defineProperty so hostile keys like `__proto__` cannot alter the prototype.
    const out: Record<string, unknown> = {};
    let failed = false;
    for (const key of Object.keys(this.shape)) {
      const schema = this.shape[key]!;
      const raw = Object.hasOwn(input, key) ? input[key] : undefined;
      if (raw === undefined && !schema.acceptsMissing) {
        ctx.at(key, () => ctx.report('required', 'is required'));
        failed = true;
        continue;
      }
      const value = ctx.at(key, () => schema.check(raw, ctx));
      if (value === INVALID) failed = true;
      else if (value !== undefined) defineField(out, key, value);
    }
    for (const key of Object.keys(input)) {
      if (Object.hasOwn(this.shape, key)) continue;
      if (this.unknownKeys === 'passthrough') {
        defineField(out, key, input[key]);
      } else if (this.unknownKeys === 'reject') {
        const suggestion = closestMatch(key, Object.keys(this.shape));
        ctx.at(key, () =>
          ctx.report(
            'unknown_key',
            'is not a recognised option',
            suggestion === undefined ? undefined : `did you mean "${suggestion}"?`,
          ),
        );
        failed = true;
      }
    }
    return failed ? INVALID : (out as ObjectOutput<S>);
  }

  /** A copy of this schema with more fields. */
  extend<E extends Shape>(extra: E): ObjectSchema<S & E> {
    return new ObjectSchema({ ...this.shape, ...extra }, this.unknownKeys);
  }

  /** A copy of this schema that ignores unknown keys instead of rejecting them. */
  strip(): ObjectSchema<S> {
    return new ObjectSchema(this.shape, 'strip');
  }

  passthrough(): ObjectSchema<S> {
    return new ObjectSchema(this.shape, 'passthrough');
  }

  protected docBase(): SchemaDoc {
    const fields: Record<string, SchemaDoc> = {};
    for (const [key, schema] of Object.entries(this.shape)) fields[key] = schema.toDoc();
    return { type: 'object', fields };
  }

  protected override redactInner(input: unknown): unknown {
    if (!isPlainObject(input)) return input;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      const schema = Object.hasOwn(this.shape, key) ? this.shape[key] : undefined;
      defineField(out, key, schema === undefined ? input[key] : schema.redact(input[key]));
    }
    return out;
  }
}

function defineField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export interface RecordOptions {
  /** Constraint on keys, e.g. component IDs. */
  keyPattern?: RegExp;
  keyPatternName?: string;
}

/** An object with arbitrary keys and uniformly typed values, returned as a `Map` in key order. */
export class RecordSchema<V> extends Schema<Map<string, V>> {
  constructor(
    readonly value: Schema<V>,
    private readonly options: RecordOptions = {},
  ) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<Map<string, V>> {
    if (!isPlainObject(input)) {
      return ctx.report('invalid_type', `expected an object, got ${describeInput(input)}`);
    }
    const out = new Map<string, V>();
    let failed = false;
    for (const key of Object.keys(input)) {
      const { keyPattern, keyPatternName } = this.options;
      if (keyPattern !== undefined && !keyPattern.test(key)) {
        ctx.at(key, () =>
          ctx.report(
            'invalid_string',
            `key must be ${keyPatternName ?? `a string matching ${String(keyPattern)}`}`,
          ),
        );
        failed = true;
        continue;
      }
      const value = ctx.at(key, () => this.value.check(input[key], ctx));
      if (value === INVALID) failed = true;
      else out.set(key, value);
    }
    return failed ? INVALID : out;
  }

  protected docBase(): SchemaDoc {
    return { type: 'record', items: this.value.toDoc() };
  }

  protected override redactInner(input: unknown): unknown {
    if (!isPlainObject(input)) return input;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) defineField(out, key, this.value.redact(input[key]));
    return out;
  }
}

/**
 * The first variant that accepts the input wins. When none do, the issues of the variant that
 * got furthest (fewest issues, provided it accepted the input's basic type) are reported, which
 * gives far better messages than "no variant matched".
 */
export class UnionSchema<T extends readonly Schema<unknown>[]> extends Schema<Infer<T[number]>> {
  constructor(readonly variants: T) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<Infer<T[number]>> {
    let best: Issue[] | undefined;
    for (const variant of this.variants) {
      const trial = new ParseContext();
      const value =
        ctx.currentPath.length === 0
          ? variant.check(input, trial)
          : withPath(trial, ctx.currentPath, () => variant.check(input, trial));
      if (value !== INVALID && trial.issues.length === 0) return value as Infer<T[number]>;
      const typeMismatch = trial.issues.every(
        (i) => i.code === 'invalid_type' && i.path.length === ctx.currentPath.length,
      );
      if (!typeMismatch && (best === undefined || trial.issues.length < best.length)) {
        best = trial.issues;
      }
    }
    if (best !== undefined) {
      ctx.issues.push(...best);
      return INVALID;
    }
    const expected = this.variants.map((v) => v.toDoc().type).join(' or ');
    return ctx.report('invalid_union', `expected ${expected}, got ${describeInput(input)}`);
  }

  protected docBase(): SchemaDoc {
    return { type: 'union', variants: this.variants.map((v) => v.toDoc()) };
  }

  protected override redactInner(input: unknown): unknown {
    for (const variant of this.variants) {
      if (variant.safeParse(input).ok) return variant.redact(input);
    }
    return input;
  }
}

function withPath<T>(ctx: ParseContext, path: IssuePath, fn: () => T): T {
  const [head, ...rest] = path;
  if (head === undefined) return fn();
  return ctx.at(head, () => withPath(ctx, rest, fn));
}

/**
 * A union of object schemas selected by a string field, e.g. `type: http`. Errors name the
 * valid choices and suggest the closest one for typos.
 */
export class DiscriminatedUnionSchema<
  K extends string,
  V extends Record<string, ObjectSchema<Shape>>,
> extends Schema<{ [T in keyof V]: Infer<V[T]> & { [P in K]: T } }[keyof V]> {
  constructor(
    readonly discriminator: K,
    readonly variants: V,
  ) {
    super();
  }

  check(
    input: unknown,
    ctx: ParseContext,
  ): Result<{ [T in keyof V]: Infer<V[T]> & { [P in K]: T } }[keyof V]> {
    if (!isPlainObject(input)) {
      return ctx.report('invalid_type', `expected an object, got ${describeInput(input)}`);
    }
    const tag = input[this.discriminator];
    const names = Object.keys(this.variants);
    if (typeof tag !== 'string' || !Object.hasOwn(this.variants, tag)) {
      return ctx.at(this.discriminator, () => {
        if (tag === undefined) {
          return ctx.report('required', `is required (one of ${names.join(', ')})`);
        }
        const suggestion = typeof tag === 'string' ? closestMatch(tag, names) : undefined;
        return ctx.report(
          'invalid_enum',
          `unknown ${this.discriminator} ${JSON.stringify(tag)}; expected one of ${names.join(', ')}`,
          suggestion === undefined ? undefined : `did you mean "${suggestion}"?`,
        );
      });
    }
    const { [this.discriminator]: _tag, ...rest } = input;
    const value = this.variants[tag]!.check(rest, ctx);
    if (value === INVALID) return INVALID;
    return { ...(value as object), [this.discriminator]: tag } as {
      [T in keyof V]: Infer<V[T]> & { [P in K]: T };
    }[keyof V];
  }

  protected docBase(): SchemaDoc {
    return {
      type: 'tagged_union',
      discriminator: this.discriminator,
      variants: Object.entries(this.variants).map(([name, schema]) => ({
        ...schema.toDoc(),
        values: [name],
      })),
    };
  }

  protected override redactInner(input: unknown): unknown {
    if (!isPlainObject(input)) return input;
    const tag = input[this.discriminator];
    if (typeof tag !== 'string' || !Object.hasOwn(this.variants, tag)) return input;
    return this.variants[tag]!.redact(input);
  }
}

/** Defers schema construction, for recursive structures. */
export class LazySchema<T> extends Schema<T> {
  private resolved: Schema<T> | undefined;

  constructor(private readonly factory: () => Schema<T>) {
    super();
  }

  private get inner(): Schema<T> {
    this.resolved ??= this.factory();
    return this.resolved;
  }

  check(input: unknown, ctx: ParseContext): Result<T> {
    return this.inner.check(input, ctx);
  }

  protected docBase(): SchemaDoc {
    return { type: 'lazy' };
  }

  protected override redactInner(input: unknown): unknown {
    return this.inner.redact(input);
  }
}
