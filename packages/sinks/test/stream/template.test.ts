import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LogEvent, MetricEvent, Timestamp } from '@ferrule/core';
import {
  compileTemplate,
  getEventField,
  renderTemplate,
  renderTemplateTimeOnly,
} from '../../src/stream/template.js';

const NOW = Timestamp.fromCivil({
  year: 2026,
  month: 3,
  day: 5,
  hour: 13,
  minute: 7,
  second: 9,
});

describe('compileTemplate / renderTemplate', () => {
  it('renders a plain literal unchanged', () => {
    const t = compileTemplate('plain/path.log');
    expect(t.isConstant).toBe(true);
    expect(renderTemplate(t, LogEvent.fromMessage('x'), NOW)).toBe('plain/path.log');
  });

  it('substitutes field references', () => {
    const t = compileTemplate('{{ host }}/{{ service.name }}.log');
    const event = LogEvent.from({ host: 'web-1', service: { name: 'api' } });
    expect(renderTemplate(t, event, NOW)).toBe('web-1/api.log');
  });

  it('renders a missing field reference as empty', () => {
    const t = compileTemplate('{{ missing }}.log');
    expect(renderTemplate(t, LogEvent.fromMessage('x'), NOW)).toBe('.log');
  });

  it('renders strftime-style time specifiers against the supplied `now`', () => {
    const t = compileTemplate('%Y/%m/%d/%H-%M-%S.log');
    expect(renderTemplate(t, LogEvent.fromMessage('x'), NOW)).toBe('2026/03/05/13-07-09.log');
  });

  it('renders %j as the day of year', () => {
    const jan1 = Timestamp.fromCivil({ year: 2026, month: 1, day: 1 });
    const feb1 = Timestamp.fromCivil({ year: 2026, month: 2, day: 1 });
    expect(renderTemplate(compileTemplate('%j'), LogEvent.fromMessage('x'), jan1)).toBe('001');
    expect(renderTemplate(compileTemplate('%j'), LogEvent.fromMessage('x'), feb1)).toBe('032');
  });

  it('renders a literal %% as a single percent', () => {
    expect(renderTemplate(compileTemplate('100%%'), LogEvent.fromMessage('x'), NOW)).toBe('100%');
  });

  it('mixes field references and time specifiers', () => {
    const t = compileTemplate('{{ host }}/%Y-%m-%d.log');
    const event = LogEvent.from({ host: 'db-2' });
    expect(renderTemplate(t, event, NOW)).toBe('db-2/2026-03-05.log');
  });

  it('leaves an unterminated {{ as a literal', () => {
    const t = compileTemplate('a{{b');
    expect(renderTemplate(t, LogEvent.fromMessage('x'), NOW)).toBe('a{{b');
  });

  it('renderTemplateTimeOnly throws if the template has field references', () => {
    const t = compileTemplate('{{ host }}');
    expect(() => renderTemplateTimeOnly(t, NOW)).toThrow(/references event fields/);
  });

  it('renderTemplateTimeOnly renders a pure time template with no event', () => {
    const t = compileTemplate('%Y');
    expect(renderTemplateTimeOnly(t, NOW)).toBe('2026');
  });
});

describe('getEventField', () => {
  it('reads MetricEvent name and tags', () => {
    const metric = new MetricEvent({
      name: 'requests',
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
      tags: { region: 'us-east' },
    });
    expect(getEventField(metric, ['name'])).toBe('requests');
    expect(getEventField(metric, ['tags', 'region'])).toBe('us-east');
    expect(getEventField(metric, ['tags', 'missing'])).toBeUndefined();
    expect(getEventField(metric, ['value'])).toBeUndefined();
  });
});

describe('compileTemplate property: rendering a constant-literal template is idempotent', () => {
  it('round-trips arbitrary literal-only strings (no {{ or strftime specifiers)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 40 }).filter((s) => !/[{%]/.test(s)),
        (literal) => {
          const t = compileTemplate(literal);
          expect(renderTemplate(t, LogEvent.fromMessage('x'), NOW)).toBe(literal);
        },
      ),
    );
  });
});
