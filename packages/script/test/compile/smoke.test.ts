import { LogEvent } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck, runInlineTests } from '@ferrule/script';

function compileSource(source: string) {
  const result = parseAndCheck(source);
  const diagnostics = [...result.parseDiagnostics, ...result.diagnostics];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `unexpected diagnostics: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
    );
  }
  return compile(result);
}

describe('compiler smoke test', () => {
  it('runs a simple field transform', () => {
    const program = compileSource('.level = upcase(.level) ?? "unknown"');
    const outcome = program.run(LogEvent.from({ level: 'warn' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('level')).toBe('WARN');
    }
  });

  it('falls back through ?? when a field is missing', () => {
    const program = compileSource('.level = upcase(.level) ?? "unknown"');
    const outcome = program.run(LogEvent.from({}));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('level')).toBe('unknown');
    }
  });

  it('drops an event', () => {
    const program = compileSource('if .level == "debug" { drop }');
    const outcome = program.run(LogEvent.from({ level: 'debug' }));
    expect(outcome.kind).toBe('drop');
  });

  it('aborts an event with a reason', () => {
    const program = compileSource('if .level == "fatal" { abort "fatal event" }');
    const outcome = program.run(LogEvent.from({ level: 'fatal' }));
    expect(outcome.kind).toBe('abort');
    if (outcome.kind === 'abort') expect(outcome.reason).toBe('fatal event');
  });

  it('aborts on an unhandled assert failure', () => {
    const program = compileSource('.n = to_int(.n)!');
    const outcome = program.run(LogEvent.from({ n: 'not a number' }));
    expect(outcome.kind).toBe('abort');
  });

  it('computes int arithmetic with 64-bit wrapping', () => {
    const program = compileSource('.n = .n + 1');
    const outcome = program.run(LogEvent.from({ n: 9223372036854775807n }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('n')).toBe(-9223372036854775808n);
    }
  });

  it('emits an extra event', () => {
    const program = compileSource('emit({ "kind": "child" })');
    const outcome = program.run(LogEvent.from({ a: 1 }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events).toHaveLength(2);
      expect(outcome.events[1]!.fields.get('kind')).toBe('child');
    }
  });

  it('runs map_values and filter closures', () => {
    const program = compileSource(
      '.headers = map_values(.headers, |k, v| downcase(v) ?? v)!\n' +
        '.tags = filter(.tags, |t| is_string(t))!',
    );
    const outcome = program.run(LogEvent.from({ headers: { A: 'X' }, tags: ['a', 1, 'b'] }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      const fields = outcome.events[0]!.fields;
      expect(fields.get('headers')).toEqual(new Map([['A', 'x']]));
      expect(fields.get('tags')).toEqual(['a', 'b']);
    }
  });

  it('matches on kind and object-shape patterns', () => {
    const program = compileSource(`
      .result = match .value {
        string => "was a string",
        { code } => to_string(code),
        _ => "other",
      }
    `);
    const s = program.run(LogEvent.from({ value: 'x' }));
    if (s.kind === 'continue') expect(s.events[0]!.fields.get('result')).toBe('was a string');

    const o = program.run(LogEvent.from({ value: { code: 42 } }));
    if (o.kind === 'continue') expect(o.events[0]!.fields.get('result')).toBe('42');
  });

  it('runs inline tests', () => {
    const program = compileSource(`
      .level = downcase(.level) ?? "info"

      test "normalises level" {
        given { "level": "WARN" }
        expect { "level": "warn" }
      }
    `);
    const results = runInlineTests(program);
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
  });
});
