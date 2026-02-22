import { formatValue } from '@ferrule/core';
import type { RuntimeValue } from './context.js';
import { isRegexValue } from './regex.js';

/**
 * Renders any `RuntimeValue` in Ferrule Script literal syntax. Mirrors `@ferrule/core`'s
 * `formatValue`, but walks arrays/objects itself first (recursively) so a nested regex — never
 * possible in a plain `Value`, but now possible in a `RuntimeValue` array/object, see
 * `runtime/context.ts` — renders as `/pattern/flags` instead of `formatValue` mis-formatting it
 * as bytes (it has no idea what a `RegexValue` is).
 */
function formatRuntimeValue(value: RuntimeValue): string {
  if (isRegexValue(value)) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return `[${value.map(formatRuntimeValue).join(', ')}]`;
  if (value instanceof Map) {
    if (value.size === 0) return '{}';
    const parts: string[] = [];
    for (const [k, v] of value) parts.push(`${JSON.stringify(k)}: ${formatRuntimeValue(v)}`);
    return `{ ${parts.join(', ')} }`;
  }
  return formatValue(value);
}

/** `to_string`: the value's Ferrule Script literal form (matches the builtin's documented behavior). */
export function toLiteralString(value: RuntimeValue): string {
  return formatRuntimeValue(value);
}

/** String interpolation (`"{{ expr }}"`): strings interpolate as themselves, unquoted. */
export function toDisplayString(value: RuntimeValue): string {
  if (typeof value === 'string') return value;
  return formatRuntimeValue(value);
}
