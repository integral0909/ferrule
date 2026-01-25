import { describe, expect, it } from 'vitest';
import { FerruleError, objectOf, type ValueMap } from '@ferrule/core';
import {
  compileFieldTemplate,
  encodeUriValue,
  formatTimePattern,
  isStaticTemplate,
} from '../../src/http/templating.js';

function ctx(record: Record<string, unknown>): ValueMap {
  return objectOf(record);
}

describe('compileFieldTemplate', () => {
  it('substitutes a simple field reference', () => {
    const template = compileFieldTemplate('service={{ service }}');
    expect(template.render(ctx({ service: 'api' }))).toBe('service=api');
  });

  it('substitutes a nested field path', () => {
    const template = compileFieldTemplate('{{ http.status }}');
    expect(template.render(ctx({ http: { status: 200 } }))).toBe('200');
  });

  it('renders an empty string for a missing field', () => {
    const template = compileFieldTemplate('[{{ missing }}]');
    expect(template.render(ctx({}))).toBe('[]');
  });

  it('substitutes several placeholders in one template', () => {
    const template = compileFieldTemplate('{{ a }}-{{ b }}-{{ a }}');
    expect(template.render(ctx({ a: 'x', b: 'y' }))).toBe('x-y-x');
  });

  it('leaves a template with no placeholders untouched', () => {
    const template = compileFieldTemplate('static/path');
    expect(template.render(ctx({}))).toBe('static/path');
    expect(isStaticTemplate('static/path')).toBe(true);
    expect(isStaticTemplate('{{ x }}')).toBe(false);
  });

  it('applies the optional encode function to each substituted value, not literals', () => {
    const template = compileFieldTemplate('literal/{{ field }}');
    const rendered = template.render(ctx({ field: 'a b' }), (v) => v.toUpperCase());
    expect(rendered).toBe('literal/A B');
  });

  it('rejects a field reference containing an unsafe character', () => {
    for (const bad of ['{{ a; rm -rf / }}', '{{ ../secret }}', '{{ a b }}', '{{ a<b }}']) {
      expect(() => compileFieldTemplate(bad)).toThrow(FerruleError);
    }
  });

  it('rejects an empty field reference', () => {
    expect(() => compileFieldTemplate('{{ }}')).toThrow(FerruleError);
  });

  it('accepts a quoted field segment and an array index, per the field-path grammar', () => {
    // The quoted-segment syntax is accepted, but its contents still fall under the same
    // character allow-list as everywhere else in a field reference (no spaces, punctuation, etc.)
    // — this is a safe subset of the full field-path grammar's quoted-segment escaping, not an
    // escape hatch from it.
    const template = compileFieldTemplate('{{ "weird-key" }}/{{ items[0] }}');
    expect(template.render(ctx({ 'weird-key': 'v', items: ['first'] }))).toBe('v/first');
  });

  it('exposes the parsed field paths referenced by the template', () => {
    const template = compileFieldTemplate('{{ a.b }}-{{ c }}');
    expect(template.fields).toEqual([['a', 'b'], ['c']]);
  });
});

describe('encodeUriValue', () => {
  it('percent-encodes reserved URI characters', () => {
    expect(encodeUriValue('a/b c')).toBe('a%2Fb%20c');
    expect(encodeUriValue("it's")).toBe('it%27s');
  });
});

describe('formatTimePattern', () => {
  const date = new Date(Date.UTC(2024, 2, 5, 7, 8, 9)); // 2024-03-05T07:08:09Z

  it('formats the standard tokens with zero-padding', () => {
    expect(formatTimePattern('%Y/%m/%d/%H:%M:%S', date)).toBe('2024/03/05/07:08:09');
  });

  it('formats day-of-year and unix seconds', () => {
    expect(formatTimePattern('%j', date)).toBe('065');
    expect(formatTimePattern('%s', date)).toBe(String(Math.floor(date.getTime() / 1000)));
  });

  it('leaves an unrecognised token and passes through a literal percent', () => {
    expect(formatTimePattern('%%literal%%', date)).toBe('%literal%');
    expect(formatTimePattern('%q', date)).toBe('%q');
  });
});
