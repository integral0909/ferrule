import { describe, expect, it } from 'vitest';
import {
  check,
  DIAGNOSTIC_CATALOG,
  explainCode,
  makeDiagnostic,
  parse,
  renderDiagnostic,
  renderDiagnostics,
  SourceFile,
  summarizeDiagnostic,
} from '@ferrule/script';

describe('diagnostic catalog', () => {
  it('has a unique code for every entry', () => {
    const codes = DIAGNOSTIC_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('explains a known code and returns undefined for an unknown one', () => {
    expect(explainCode('E401')?.summary).toBe('unhandled fallible expression');
    expect(explainCode('E999')).toBeUndefined();
  });

  it('gives every warning a W-prefixed code', () => {
    for (const e of DIAGNOSTIC_CATALOG) {
      if (e.severity === 'warning') expect(e.code).toMatch(/^W/);
      else expect(e.code).toMatch(/^E/);
    }
  });

  it('looks up the default severity for a code that omits it', () => {
    const d = makeDiagnostic({ code: 'W503', message: 'unused', span: { start: 0, end: 1 } });
    expect(d.severity).toBe('warning');
  });

  it('defaults to error severity for a code not in the catalog', () => {
    const d = makeDiagnostic({ code: 'E999', message: 'x', span: { start: 0, end: 1 } });
    expect(d.severity).toBe('error');
  });

  it('still resolves a renamed E-code to its replacement, with a note about the rename', () => {
    const renamed = explainCode('E205');
    const current = explainCode('W503');
    expect(renamed).toBeDefined();
    expect(renamed?.code).toBe('W503');
    expect(renamed?.severity).toBe('warning');
    expect(renamed?.summary).toBe(current?.summary);
    expect(renamed?.explanation).toContain('E205');
    expect(renamed?.explanation).toContain('W503');
    // The live catalog entry itself is unaffected by looking it up under its old code.
    expect(current?.explanation).not.toContain('renamed');

    expect(explainCode('E206')?.code).toBe('W504');
    expect(explainCode('E402')?.code).toBe('W505');
  });
});

describe('renderDiagnostic', () => {
  const source = new SourceFile('pipeline.fer', 'let x = to_int(.code)\nlet y = 1\n');
  const { program } = parse(source);
  const result = check(program);

  it('renders a header with file, line, and column', () => {
    const diagnostic = result.diagnostics.find((d) => d.code === 'E401')!;
    const text = renderDiagnostic(diagnostic, source);
    expect(text).toContain('error[E401]');
    expect(text).toContain('pipeline.fer:1:');
    expect(text).toContain('unhandled fallible expression');
  });

  it('shows the offending source line with a caret underline', () => {
    const diagnostic = result.diagnostics.find((d) => d.code === 'E401')!;
    const text = renderDiagnostic(diagnostic, source);
    expect(text).toContain('let x = to_int(.code)');
    expect(text).toMatch(/\^+/);
  });

  it('renders notes with `= note:` and fixes with `= help:`', () => {
    const diagnostic = result.diagnostics.find((d) => d.code === 'E401')!;
    const text = renderDiagnostic(diagnostic, source);
    expect(text).toContain('= note:');
    expect(text).toContain('= help:');
  });

  it('colorizes with ANSI escapes when requested', () => {
    const diagnostic = result.diagnostics.find((d) => d.code === 'E401')!;
    const plain = renderDiagnostic(diagnostic, source);
    const colored = renderDiagnostic(diagnostic, source, { color: true });
    expect(colored).not.toBe(plain);
    expect(colored).toContain('\x1b[');
  });

  it('renders multiple diagnostics sorted by position, separated by a blank line', () => {
    const src2 = new SourceFile('<t>', 'let x = 1\nlet x = 2\nlet y = to_int(.a)\n');
    const { program: p2 } = parse(src2);
    const r2 = check(p2);
    const text = renderDiagnostics(r2.diagnostics, src2);
    const e203 = text.indexOf('E203');
    const e401 = text.indexOf('E401');
    expect(e203).toBeGreaterThan(-1);
    expect(e401).toBeGreaterThan(-1);
    expect(e203).toBeLessThan(e401);
    expect(text).toContain('\n\n');
  });

  it('summarizes a diagnostic on one line', () => {
    const diagnostic = result.diagnostics.find((d) => d.code === 'E401')!;
    const summary = summarizeDiagnostic(diagnostic, source);
    expect(summary.startsWith('pipeline.fer:1:')).toBe(true);
    expect(summary).toContain('error[E401]');
    expect(summary.split('\n')).toHaveLength(1);
  });

  it('never throws for an empty diagnostics list', () => {
    expect(() => renderDiagnostics([], source)).not.toThrow();
    expect(renderDiagnostics([], source)).toBe('');
  });
});
