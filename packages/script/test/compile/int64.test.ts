import { LogEvent, wrapInt64 } from '@ferrule/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck } from '@ferrule/script';

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function compileAndRun(source: string, fields: Record<string, unknown>) {
  const result = parseAndCheck(source);
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join('; '));
  return compile(result).run(LogEvent.from(fields));
}

const int64Arbitrary = fc.bigInt({ min: INT64_MIN, max: INT64_MAX });

describe('int64 wraparound', () => {
  it('property: a + b wraps exactly like BigInt.asIntN(64, a + b)', () => {
    fc.assert(
      fc.property(int64Arbitrary, int64Arbitrary, (a, b) => {
        const outcome = compileAndRun('.r = .a + .b', { a, b });
        if (outcome.kind !== 'continue') throw new Error(`expected continue, got ${outcome.kind}`);
        expect(outcome.events[0]!.fields.get('r')).toBe(wrapInt64(a + b));
      }),
    );
  });

  it('property: a - b wraps exactly like BigInt.asIntN(64, a - b)', () => {
    fc.assert(
      fc.property(int64Arbitrary, int64Arbitrary, (a, b) => {
        const outcome = compileAndRun('.r = .a - .b', { a, b });
        if (outcome.kind !== 'continue') throw new Error(`expected continue, got ${outcome.kind}`);
        expect(outcome.events[0]!.fields.get('r')).toBe(wrapInt64(a - b));
      }),
    );
  });

  it('property: a * b wraps exactly like BigInt.asIntN(64, a * b)', () => {
    fc.assert(
      fc.property(int64Arbitrary, int64Arbitrary, (a, b) => {
        const outcome = compileAndRun('.r = .a * .b', { a, b });
        if (outcome.kind !== 'continue') throw new Error(`expected continue, got ${outcome.kind}`);
        expect(outcome.events[0]!.fields.get('r')).toBe(wrapInt64(a * b));
      }),
    );
  });

  it('unary negation of INT64_MIN wraps back to INT64_MIN', () => {
    const outcome = compileAndRun('.r = -.a', { a: INT64_MIN });
    if (outcome.kind !== 'continue') throw new Error('expected continue');
    expect(outcome.events[0]!.fields.get('r')).toBe(INT64_MIN);
  });

  it('INT64_MAX + 1 wraps to INT64_MIN', () => {
    const outcome = compileAndRun('.r = .a + 1', { a: INT64_MAX });
    if (outcome.kind !== 'continue') throw new Error('expected continue');
    expect(outcome.events[0]!.fields.get('r')).toBe(INT64_MIN);
  });

  it('INT64_MIN - 1 wraps to INT64_MAX', () => {
    const outcome = compileAndRun('.r = .a - 1', { a: INT64_MIN });
    if (outcome.kind !== 'continue') throw new Error('expected continue');
    expect(outcome.events[0]!.fields.get('r')).toBe(INT64_MAX);
  });

  it('division by zero fails rather than wrapping or crashing', () => {
    const outcome = compileAndRun('.r = (.a / .b)!', { a: 10n, b: 0n });
    expect(outcome.kind).toBe('abort');
  });

  it('modulo by zero fails rather than wrapping or crashing', () => {
    const outcome = compileAndRun('.r = (.a % .b)!', { a: 10n, b: 0n });
    expect(outcome.kind).toBe('abort');
  });

  it('INT64_MIN / -1 (the classic overflow case) wraps rather than crashing', () => {
    const outcome = compileAndRun('.r = (.a / .b)!', { a: INT64_MIN, b: -1n });
    if (outcome.kind !== 'continue') throw new Error(`expected continue, got ${outcome.kind}`);
    expect(outcome.events[0]!.fields.get('r')).toBe(wrapInt64(INT64_MIN / -1n));
  });
});
