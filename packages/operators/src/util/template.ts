import { formatFloat, parsePath, Timestamp, type Path, type Value } from '@ferrule/core';

/**
 * A minimal `{field.path}` template renderer, used where an operator's options need to name a
 * metric or a tag value from event data (`log_to_metric`'s name/tag templates) without pulling
 * in a scripting language. `{{` and `}}` escape a literal brace.
 */
export interface Template {
  render(get: (path: Path) => Value | undefined): string;
  /** True if the template has no `{field}` references (a plain constant string). */
  readonly isConstant: boolean;
}

interface Part {
  readonly literal?: string;
  readonly field?: Path;
}

export function compileTemplate(text: string): Template {
  const parts: Part[] = [];
  let literal = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '{' && text[i + 1] === '{') {
      literal += '{';
      i += 2;
      continue;
    }
    if (c === '}' && text[i + 1] === '}') {
      literal += '}';
      i += 2;
      continue;
    }
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      if (end === -1) {
        literal += c;
        i++;
        continue;
      }
      if (literal.length > 0) {
        parts.push({ literal });
        literal = '';
      }
      const fieldText = text.slice(i + 1, end).trim();
      parts.push({ field: parsePath(fieldText) });
      i = end + 1;
      continue;
    }
    literal += c;
    i++;
  }
  if (literal.length > 0) parts.push({ literal });

  const isConstant = parts.every((p) => p.field === undefined);
  return {
    isConstant,
    render(get: (path: Path) => Value | undefined): string {
      let out = '';
      for (const part of parts) {
        if (part.literal !== undefined) {
          out += part.literal;
        } else {
          out += valueToTemplateText(get(part.field!));
        }
      }
      return out;
    },
  };
}

/** Renders a value the way a template substitution should: no quotes, no type markers. */
export function valueToTemplateText(value: Value | undefined): string {
  if (value === undefined || value === null) return '';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'number':
      return formatFloat(value);
    case 'string':
      return value;
    default:
      break;
  }
  if (value instanceof Timestamp) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => valueToTemplateText(v)).join(',');
  if (value instanceof Map) {
    return [...value.entries()].map(([k, v]) => `${k}=${valueToTemplateText(v)}`).join(',');
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
}
