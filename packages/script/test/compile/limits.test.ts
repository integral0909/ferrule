import { LogEvent } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck } from '@ferrule/script';

function compileSource(source: string) {
  const result = parseAndCheck(source);
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join('; '));
  return compile(result);
}

describe('resource limits', () => {
  it('aborts with a distinct reason when string concatenation exceeds the limit', () => {
    const program = compileSource('.r = .a + .b');
    const outcome = program.run(LogEvent.from({ a: 'x'.repeat(80), b: 'y'.repeat(80) }), {
      limits: { maxStringLength: 100 },
    });
    expect(outcome.kind).toBe('abort');
    if (outcome.kind === 'abort') expect(outcome.reason).toContain('limit exceeded');
  });

  it('aborts with a distinct reason when string interpolation exceeds the limit', () => {
    const program = compileSource('.r = "{{ .a }}{{ .b }}"');
    const outcome = program.run(LogEvent.from({ a: 'x'.repeat(80), b: 'y'.repeat(80) }), {
      limits: { maxStringLength: 100 },
    });
    expect(outcome.kind).toBe('abort');
    if (outcome.kind === 'abort') expect(outcome.reason).toContain('limit exceeded');
  });

  it('does not abort when comfortably under the string length limit', () => {
    const program = compileSource('.r = .a + .b');
    const outcome = program.run(LogEvent.from({ a: 'x', b: 'y' }), {
      limits: { maxStringLength: 100 },
    });
    expect(outcome.kind).toBe('continue');
  });

  it('aborts with a distinct reason when an array literal exceeds the collection size limit', () => {
    const program = compileSource('.r = [1, 2, 3, 4, 5]');
    const outcome = program.run(LogEvent.from({}), { limits: { maxCollectionSize: 3 } });
    expect(outcome.kind).toBe('abort');
    if (outcome.kind === 'abort') expect(outcome.reason).toContain('limit exceeded');
  });

  it('aborts with a distinct reason when emit() exceeds the max emitted events limit', () => {
    const program = compileSource('emit({ "n": 1 })\nemit({ "n": 2 })\nemit({ "n": 3 })');
    const outcome = program.run(LogEvent.from({}), { limits: { maxEmittedEvents: 2 } });
    expect(outcome.kind).toBe('abort');
    if (outcome.kind === 'abort') expect(outcome.reason).toContain('limit exceeded');
  });

  it('allows emit() up to the limit', () => {
    const program = compileSource('emit({ "n": 1 })\nemit({ "n": 2 })');
    const outcome = program.run(LogEvent.from({}), { limits: { maxEmittedEvents: 2 } });
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') expect(outcome.events).toHaveLength(3);
  });

  it('applies default limits when none are given (a large but finite string still succeeds)', () => {
    const program = compileSource('.r = .a + .b');
    const outcome = program.run(LogEvent.from({ a: 'x'.repeat(1000), b: 'y'.repeat(1000) }));
    expect(outcome.kind).toBe('continue');
  });
});
