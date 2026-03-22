import { describe, expect, it } from 'vitest';
import { FerruleError } from '@ferrule/core';
import { log } from '@ferrule/testkit';
import { compileCondition, evaluateCondition } from '../src/scriptCondition.js';

describe('compileCondition / evaluateCondition', () => {
  it('matches a true condition', () => {
    const program = compileCondition('.status == 200');
    expect(evaluateCondition(program, log({ status: 200 }))).toEqual({ ok: true, matched: true });
  });

  it('does not match a false condition', () => {
    const program = compileCondition('.status == 200');
    expect(evaluateCondition(program, log({ status: 500 }))).toEqual({ ok: true, matched: false });
  });

  it('reports an unhandled abort as ok: false', () => {
    const program = compileCondition('.enabled');
    const result = evaluateCondition(program, log({ enabled: 'not a bool' }));
    expect(result.ok).toBe(false);
  });

  it('evaluating the same event twice is stable (each run gets a fresh clone)', () => {
    const program = compileCondition('.status == 200');
    const event = log({ status: 200 });
    expect(evaluateCondition(program, event)).toEqual({ ok: true, matched: true });
    expect(evaluateCondition(program, event)).toEqual({ ok: true, matched: true });
    expect(event.fields.size).toBe(1);
  });

  it('a fallible condition without ?? fails to compile', () => {
    expect(() => compileCondition('to_bool(.n)')).toThrow(FerruleError);
  });

  it('surfaces a compile error with a rendered code frame', () => {
    expect(() => compileCondition('.a ==')).toThrowError(/condition failed to compile/);
  });
});
