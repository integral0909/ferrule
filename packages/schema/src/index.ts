import {
  ByteSizeSchema,
  COMPONENT_ID,
  DurationSchema,
  FieldPathSchema,
  RegexSchema,
  SocketAddressSchema,
  UrlSchema,
  type ByteSizeOptions,
  type DurationOptions,
  type UrlOptions,
} from './formats.js';
import {
  ArraySchema,
  BooleanSchema,
  DiscriminatedUnionSchema,
  EnumSchema,
  LazySchema,
  LiteralSchema,
  NumberSchema,
  ObjectSchema,
  RecordSchema,
  StringSchema,
  UnionSchema,
  UnknownSchema,
  type ArrayOptions,
  type NumberOptions,
  type RecordOptions,
  type Schema,
  type Shape,
  type StringOptions,
} from './schema.js';

export * from './formats.js';
export * from './issues.js';
export * from './schema.js';

/**
 * Schema builders. Component option schemas are written with these:
 *
 * ```ts
 * const options = s.object({
 *   address: s.socketAddress(),
 *   max_body: s.byteSize().default(10 * 1024 * 1024),
 *   timeout: s.duration().default(30_000),
 *   auth: s.object({ token: s.string().secret() }).optional(),
 * });
 * type Options = Infer<typeof options>;
 * ```
 */
export const s = {
  string: (options?: StringOptions) => new StringSchema(options),
  number: (options?: NumberOptions) => new NumberSchema(options),
  integer: (options?: Omit<NumberOptions, 'integer'>) =>
    new NumberSchema({ ...options, integer: true }),
  boolean: () => new BooleanSchema(),
  literal: <T extends string | number | boolean | null>(value: T) => new LiteralSchema(value),
  enum: <const T extends string>(values: readonly T[]) => new EnumSchema(values),
  unknown: () => new UnknownSchema(),
  array: <T>(item: Schema<T>, options?: ArrayOptions) => new ArraySchema(item, options),
  object: <S extends Shape>(shape: S) => new ObjectSchema(shape),
  record: <V>(value: Schema<V>, options?: RecordOptions) => new RecordSchema(value, options),
  union: <const T extends readonly Schema<unknown>[]>(...variants: T) => new UnionSchema(variants),
  tagged: <K extends string, V extends Record<string, ObjectSchema<Shape>>>(
    discriminator: K,
    variants: V,
  ) => new DiscriminatedUnionSchema(discriminator, variants),
  lazy: <T>(factory: () => Schema<T>) => new LazySchema(factory),
  duration: (options?: DurationOptions) => new DurationSchema(options),
  byteSize: (options?: ByteSizeOptions) => new ByteSizeSchema(options),
  socketAddress: (allowEphemeralPort?: boolean) => new SocketAddressSchema(allowEphemeralPort),
  url: (options?: UrlOptions) => new UrlSchema(options),
  fieldPath: () => new FieldPathSchema(),
  regex: (flags?: string) => new RegexSchema(flags),
  componentId: () =>
    new StringSchema({
      pattern: COMPONENT_ID,
      patternName: 'a component ID (lowercase letters, digits, "_" or "-", starting with a letter)',
    }),
} as const;
