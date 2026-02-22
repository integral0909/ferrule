import { LogEvent } from '@ferrule/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck, type CheckResult, type Outcome } from '@ferrule/script';

function check(source: string): CheckResult {
  const result = parseAndCheck(source);
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) throw new Error(errors.map((d) => `${d.code}: ${d.message}`).join('; '));
  return result;
}

function outcomesEqual(a: Outcome, b: Outcome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'continue' && b.kind === 'continue') {
    if (a.events.length !== b.events.length) return false;
    return a.events.every((e, i) => fieldsEqual(e.fields, b.events[i]!.fields));
  }
  if (a.kind === 'abort' && b.kind === 'abort') return a.reason === b.reason;
  return true; // both 'drop'
}

function fieldsEqual(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!deepEqual(v, b.get(k))) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Map && b instanceof Map) {
    return fieldsEqual(a as Map<string, unknown>, b as Map<string, unknown>);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

/**
 * Every program here is written to exercise at least one optimizer rewrite (constant folding of a
 * pure call or operator, dead-branch elimination, or dropping an unused `let`) so the property
 * test is not vacuous. `fieldsAffectedBy` describes what random event fields each program reads,
 * so the property test can generate matching random inputs.
 */
const PROGRAMS: readonly { readonly source: string; readonly fields: readonly string[] }[] = [
  { source: '.r = 1 + 2 * 3', fields: [] },
  { source: '.r = upcase("shout") + to_string(.n)', fields: ['n'] },
  { source: 'let unused = 1 + 2\n.r = .n', fields: ['n'] },
  { source: 'if true { .r = 1 } else { .r = 2 }', fields: [] },
  { source: 'if false { .r = 1 } else { .r = .n }', fields: ['n'] },
  { source: '.r = if 1 < 2 { "small" } else { "large" }', fields: [] },
  { source: '.r = (1 == 1) && (.n > 0)', fields: ['n'] },
  { source: '.r = to_int("42") ?? -1', fields: [] },
  { source: '.r = to_int("nope") ?? -1', fields: [] },
  { source: '.r = (10 / .n)!', fields: ['n'] },
  { source: '.r = .n + 1\nlet also_unused = upcase("x")', fields: ['n'] },
  { source: 'let x = is_string(.n)\n.r = if x { "s" } else { "other" }', fields: ['n'] },
];

describe('optimizer equivalence', () => {
  for (const { source, fields } of PROGRAMS) {
    it(`optimized and unoptimized agree: ${JSON.stringify(source)}`, () => {
      const checked = check(source);
      const optimized = compile(checked, { optimize: true });
      const unoptimized = compile(checked, { optimize: false });

      fc.assert(
        fc.property(
          fc.record(
            Object.fromEntries(
              fields.map((f) => [
                f,
                fc.oneof(
                  fc.bigInt({ min: -1000n, max: 1000n }),
                  fc.string({ maxLength: 8 }),
                  fc.constant(null),
                ),
              ]),
            ),
          ),
          (record) => {
            const event = () => LogEvent.from(record);
            const a = optimized.run(event());
            const b = unoptimized.run(event());
            expect(outcomesEqual(a, b)).toBe(true);
          },
        ),
        { numRuns: 25 },
      );
    });
  }

  it('optimizing does not change the slot count ordering in a way that breaks nested closures', () => {
    const checked = check('.r = map_values(.h, |k, v| downcase(v) ?? v)!\nlet unused = 1 + 1');
    const optimized = compile(checked, { optimize: true });
    const unoptimized = compile(checked, { optimize: false });
    for (const h of [{}, { A: 'X' }, { A: 'X', B: 'Y' }]) {
      const a = optimized.run(LogEvent.from({ h }));
      const b = unoptimized.run(LogEvent.from({ h }));
      expect(outcomesEqual(a, b)).toBe(true);
    }
  });
});
