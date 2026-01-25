import { FerruleError, getPath, parsePath, type Path, type ValueMap } from '@ferrule/core';
import { stringifyValue } from '@ferrule/codecs';

/**
 * Field templating shared by every sink that builds a URI, object key, or label set from event
 * data: `{{ field.path }}` is replaced with the stringified value of that field, read from a
 * `ValueMap` "context" the caller builds from whatever event(s) are in play (a `LogEvent`'s own
 * fields, or a small synthetic map of a metric's name/tags, etc.).
 *
 * The field reference between `{{` and `}}` is restricted to a safe allow-list of characters —
 * the same characters {@link parsePath} itself accepts (letters, digits, `_`, `.`, `[]`, `-`,
 * `@`, and `"..."` for a quoted segment) — so a template can never smuggle URL/path metacharacters
 * (`/`, `?`, `..`, whitespace, control characters) into a rendered value through a crafted field
 * *name* in the template text itself. The field *value* substituted at render time is untrusted
 * event data and is the caller's responsibility to encode appropriately for its destination (see
 * the `encode` parameter of {@link CompiledFieldTemplate.render}).
 */
export interface CompiledFieldTemplate {
  readonly source: string;
  /** Every field path referenced by the template, in order of appearance. */
  readonly fields: readonly Path[];
  render(context: ValueMap, encode?: (value: string) => string): string;
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SAFE_FIELD_REF = /^[A-Za-z0-9_.[\]"@-]+$/;

type TemplatePart = { literal: string } | { path: Path };

/**
 * Compiles a template containing `{{ field.path }}` placeholders. Throws `E_TEMPLATE_UNSAFE_FIELD`
 * at compile time (component build time, not per-event) if a placeholder's field reference
 * contains a character outside the safe allow-list, and `E_TEMPLATE_BAD_FIELD` if it isn't a
 * valid field path at all.
 */
export function compileFieldTemplate(template: string): CompiledFieldTemplate {
  const parts: TemplatePart[] = [];
  const fields: Path[] = [];
  let lastIndex = 0;
  // `PLACEHOLDER` carries the global flag and `matchAll` starts scanning from its *current*
  // `lastIndex` (copying it into the fresh iterator it creates) rather than always from 0, so a
  // stray `.test()`/`.exec()` call elsewhere against this shared regex object could otherwise
  // make this skip a leading match. Reset it defensively immediately before use.
  PLACEHOLDER.lastIndex = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const expr = (match[1] ?? '').trim();
    if (expr === '' || !SAFE_FIELD_REF.test(expr)) {
      throw new FerruleError(
        'E_TEMPLATE_UNSAFE_FIELD',
        `field reference ${JSON.stringify(expr)} in template ${JSON.stringify(template)} contains ` +
          'characters outside the allowed set (letters, digits, "_.[]-@" and quoted segments)',
      );
    }
    let path: Path;
    try {
      path = parsePath(expr);
    } catch (cause) {
      throw new FerruleError(
        'E_TEMPLATE_BAD_FIELD',
        `invalid field reference ${JSON.stringify(expr)} in template ${JSON.stringify(template)}`,
        { cause },
      );
    }
    parts.push({ literal: template.slice(lastIndex, match.index) });
    parts.push({ path });
    fields.push(path);
    lastIndex = match.index + match[0].length;
  }
  parts.push({ literal: template.slice(lastIndex) });

  return {
    source: template,
    fields,
    render(context, encode) {
      let out = '';
      for (const part of parts) {
        if ('literal' in part) {
          out += part.literal;
          continue;
        }
        const value = getPath(context, part.path);
        const text = value === undefined ? '' : stringifyValue(value);
        out += encode !== undefined ? encode(text) : text;
      }
      return out;
    },
  };
}

/** `true` if `template` contains no `{{ ... }}` placeholders (a static string). */
export function isStaticTemplate(template: string): boolean {
  // A fresh (non-global) regex, not the shared `PLACEHOLDER`: `.test()` on a global regex
  // mutates its `lastIndex`, which `matchAll` elsewhere would otherwise inherit as a starting
  // offset — this avoids that shared-mutable-state footgun entirely rather than resetting it.
  return !new RegExp(PLACEHOLDER.source).test(template);
}

/**
 * Percent-encodes a field value for safe insertion into a URI path or query component. Stricter
 * than `encodeURIComponent`: also encodes `!'()*`, which that function leaves unescaped.
 */
export function encodeUriValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const STRFTIME_TOKEN = /%([YmdHMSjs%])/g;

/**
 * A minimal `strftime`-style formatter (UTC only) for the handful of tokens sinks in this family
 * need for time-partitioned object keys: `%Y` `%m` `%d` `%H` `%M` `%S` (zero-padded calendar
 * fields), `%j` (zero-padded day of year), `%s` (Unix seconds), `%%` (a literal percent).
 */
export function formatTimePattern(pattern: string, date: Date): string {
  return pattern.replace(STRFTIME_TOKEN, (_, token: string) => {
    switch (token) {
      case 'Y':
        return String(date.getUTCFullYear()).padStart(4, '0');
      case 'm':
        return String(date.getUTCMonth() + 1).padStart(2, '0');
      case 'd':
        return String(date.getUTCDate()).padStart(2, '0');
      case 'H':
        return String(date.getUTCHours()).padStart(2, '0');
      case 'M':
        return String(date.getUTCMinutes()).padStart(2, '0');
      case 'S':
        return String(date.getUTCSeconds()).padStart(2, '0');
      case 'j':
        return String(dayOfYear(date)).padStart(3, '0');
      case 's':
        return String(Math.floor(date.getTime() / 1000));
      case '%':
        return '%';
      default:
        return `%${token}`;
    }
  });
}

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = Math.floor((date.getTime() - start) / 86_400_000);
  return day + 1;
}
