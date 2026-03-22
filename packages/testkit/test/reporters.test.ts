import { describe, expect, it } from 'vitest';
import {
  renderHumanReport,
  renderJsonReport,
  renderJunitReport,
  summarize,
  toJsonReport,
  type ReportCase,
} from '@ferrule/testkit';

const cases: ReportCase[] = [
  { suite: 'a.test.yaml', name: 'passes', kind: 'pipeline', passed: true, messages: [] },
  {
    suite: 'a.test.yaml',
    name: 'fails <weird> & "quoted"',
    kind: 'pipeline',
    passed: false,
    messages: ['status: expected 200, got 500'],
  },
  { suite: 'comp', name: 'inline ok', kind: 'inline_script', passed: true, messages: [] },
];

describe('reporters', () => {
  it('summarize counts totals', () => {
    const summary = summarize(cases);
    expect(summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it('renderHumanReport lists every case grouped by suite and a final summary line', () => {
    const text = renderHumanReport(summarize(cases));
    expect(text).toContain('a.test.yaml');
    expect(text).toContain('passes');
    expect(text).toContain('fails <weird> & "quoted"');
    expect(text).toContain('status: expected 200, got 500');
    expect(text).toContain('2/3 passed, 1 failed');
  });

  it('renderHumanReport with color wraps text in ANSI escapes', () => {
    const text = renderHumanReport(summarize(cases), { color: true });
    expect(text).toContain('\x1b[');
  });

  it('renderJunitReport produces well-formed, escaped XML', () => {
    const xml = renderJunitReport(summarize(cases), 'my suite');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('tests="3" failures="1"');
    expect(xml).toContain('&lt;weird&gt;');
    expect(xml).toContain('&quot;quoted&quot;');
    expect(xml).toContain('<failure');
    expect((xml.match(/<testcase\b/g) ?? []).length).toBe(3);
    expect((xml.match(/<\/testcase>/g) ?? []).length).toBe(1); // only the failing case has a body
    expect((xml.match(/\/>/g) ?? []).length).toBe(2); // the two passing cases self-close
  });

  it('renderJsonReport / toJsonReport produce a stable, parseable summary', () => {
    const summary = summarize(cases);
    const parsed = JSON.parse(renderJsonReport(summary)) as unknown;
    expect(parsed).toEqual(toJsonReport(summary));
    expect(toJsonReport(summary)).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      cases: cases.map((c) => ({ ...c })),
    });
  });
});
