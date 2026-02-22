import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck, runInlineTests } from '@ferrule/script';

function compileSource(source: string) {
  const result = parseAndCheck(source);
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) throw new Error(errors.map((d) => `${d.code}: ${d.message}`).join('; '));
  return compile(result);
}

describe('inline test runner', () => {
  it('reports a passing test', () => {
    const program = compileSource(`
      .level = downcase(.level) ?? "info"
      test "normalises level" {
        given { "level": "WARN" }
        expect { "level": "warn" }
      }
    `);
    const [result] = runInlineTests(program);
    expect(result).toMatchObject({ name: 'normalises level', passed: true, diffs: [] });
  });

  it('reports a failing test with a field diff', () => {
    const program = compileSource(`
      .level = downcase(.level) ?? "info"
      test "wrong expectation" {
        given { "level": "WARN" }
        expect { "level": "error" }
      }
    `);
    const [result] = runInlineTests(program);
    expect(result!.passed).toBe(false);
    expect(result!.diffs).toEqual([{ path: 'level', expected: 'error', actual: 'warn' }]);
  });

  it('only checks fields the expect block mentions (a partial match)', () => {
    const program = compileSource(`
      .level = downcase(.level) ?? "info"
      .extra = "untested"
      test "partial" {
        given { "level": "WARN" }
        expect { "level": "warn" }
      }
    `);
    const [result] = runInlineTests(program);
    expect(result!.passed).toBe(true);
  });

  it('reports the outcome when the transform drops the event', () => {
    const program = compileSource(`
      if .level == "debug" { drop }
      test "drops debug" {
        given { "level": "debug" }
        expect { "level": "debug" }
      }
    `);
    const [result] = runInlineTests(program);
    expect(result!.passed).toBe(false);
    expect(result!.outcome.kind).toBe('drop');
  });

  it('reports the outcome when the transform aborts the event', () => {
    const program = compileSource(`
      .n = to_int(.n)!
      test "bad input aborts" {
        given { "n": "not a number" }
        expect { "n": 0 }
      }
    `);
    const [result] = runInlineTests(program);
    expect(result!.passed).toBe(false);
    expect(result!.outcome.kind).toBe('abort');
  });

  it('runs multiple test blocks independently', () => {
    const program = compileSource(`
      .level = downcase(.level) ?? "info"
      test "a" {
        given { "level": "WARN" }
        expect { "level": "warn" }
      }
      test "b" {
        given { "level": "ERROR" }
        expect { "level": "error" }
      }
    `);
    const results = runInlineTests(program);
    expect(results.map((r) => r.passed)).toEqual([true, true]);
  });

  it('given/expect can use nested objects, arrays, and pure builtin calls', () => {
    const program = compileSource(`
      .tag = upcase(.tag) ?? "?"
      test "nested" {
        given { "tag": "x", "meta": { "list": [1, 2, upcase("z")] } }
        expect { "tag": "X" }
      }
    `);
    const [result] = runInlineTests(program);
    expect(result!.passed).toBe(true);
  });

  it('a program with no test blocks yields an empty result list', () => {
    const program = compileSource('.x = 1');
    expect(runInlineTests(program)).toEqual([]);
  });
});
