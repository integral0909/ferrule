import { fromPlain, valuesEqual, type Path, type Value } from '@ferrule/core';
import { s, type Schema } from '@ferrule/schema';

/**
 * A small, typed condition tree for operators that need to test fields without a scripting
 * language (`window_reduce`'s group start/end conditions, `tail_sampling`'s attribute-match
 * policy). Deliberately not a language: every case is a fixed shape validated by a schema, so
 * there is nothing to parse or compile.
 */
export type ConditionSpec =
  | { readonly type: 'field_exists'; readonly field: Path }
  | { readonly type: 'field_equals'; readonly field: Path; readonly value: Value }
  | { readonly type: 'field_matches'; readonly field: Path; readonly pattern: RegExp }
  | { readonly type: 'and'; readonly conditions: readonly ConditionSpec[] }
  | { readonly type: 'or'; readonly conditions: readonly ConditionSpec[] }
  | { readonly type: 'not'; readonly condition: ConditionSpec };

/** A read accessor over whatever fields a given event kind exposes (log fields, span attributes). */
export type FieldGetter = (path: Path) => Value | undefined;

/** Evaluates a condition tree against `get`. Total: every case is handled, no scripting. */
export function evaluateCondition(spec: ConditionSpec, get: FieldGetter): boolean {
  switch (spec.type) {
    case 'field_exists':
      return get(spec.field) !== undefined;
    case 'field_equals': {
      const value = get(spec.field);
      return value !== undefined && valuesEqual(value, spec.value);
    }
    case 'field_matches': {
      const value = get(spec.field);
      return typeof value === 'string' && spec.pattern.test(value);
    }
    case 'and':
      return spec.conditions.every((c) => evaluateCondition(c, get));
    case 'or':
      return spec.conditions.some((c) => evaluateCondition(c, get));
    case 'not':
      return !evaluateCondition(spec.condition, get);
  }
}

/**
 * A `Schema<ConditionSpec>`. Defined as a function (rather than a top-level `const`) so its
 * self-reference for `and`/`or`/`not` is always resolved through `s.lazy`, deferring evaluation
 * until the recursive variants are actually needed. The discriminated union's variants must be
 * plain object schemas (that is what `s.tagged` requires), so `field_equals`' JSON-typed `value`
 * is converted from `unknown` to a core `Value` in a `.transform` applied to the whole union
 * rather than inside that one variant.
 */
export function conditionSchema(): Schema<ConditionSpec> {
  return s
    .tagged('type', {
      field_exists: s.object({ field: s.fieldPath() }),
      field_equals: s.object({
        field: s.fieldPath(),
        value: s.unknown().describe('a JSON-compatible value'),
      }),
      field_matches: s.object({ field: s.fieldPath(), pattern: s.regex() }),
      and: s.object({ conditions: s.array(s.lazy(conditionSchema), { minItems: 1 }) }),
      or: s.object({ conditions: s.array(s.lazy(conditionSchema), { minItems: 1 }) }),
      not: s.object({ condition: s.lazy(conditionSchema) }),
    })
    .describe(
      'a field condition: field_exists, field_equals, field_matches (regex), or and/or/not composition',
    )
    .transform((raw, ctx): ConditionSpec | ReturnType<typeof ctx.report> => {
      if (raw.type !== 'field_equals') return raw;
      try {
        return { type: 'field_equals', field: raw.field, value: fromPlain(raw.value) };
      } catch (error) {
        return ctx.report(
          'custom',
          `invalid value: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}
