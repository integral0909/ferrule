import { kindOf, type Value, type ValueKind } from '@ferrule/core';
import type { RuntimeValue } from './context.js';
import { isRegexValue } from './regex.js';

/** The kind names design.md §3/§4's `is`/kind-pattern/`is_*` accept, as a runtime value's tag. */
export type ScriptKind = ValueKind | 'regex';

/**
 * `kindOf` only ever inspects `value`'s own top-level shape (`typeof`/`Array.isArray`/`instanceof
 * Map`/...), never its contents, so casting away the fact that a `RuntimeValue` array/object might
 * hold a regex somewhere inside it is safe here — `scriptKindOf` reports the kind of `value`
 * itself, not a verdict on what it contains.
 */
export function scriptKindOf(value: RuntimeValue): ScriptKind {
  return isRegexValue(value) ? 'regex' : kindOf(value as Value);
}

/** Whether `value`'s runtime kind matches a type name from `is`/a kind pattern (design.md §4). */
export function matchesKindName(typeName: string, value: RuntimeValue): boolean {
  switch (typeName) {
    case 'null':
    case 'bool':
    case 'string':
    case 'bytes':
    case 'timestamp':
    case 'array':
    case 'object':
    case 'regex':
      return scriptKindOf(value) === (typeName === 'bool' ? 'boolean' : typeName);
    case 'int':
      return scriptKindOf(value) === 'integer';
    case 'float':
      return scriptKindOf(value) === 'float';
    default:
      return false;
  }
}
