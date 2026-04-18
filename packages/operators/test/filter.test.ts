import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
import { FerruleError } from '@ferrule/core';
import { filterTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('filter', () => {
  it('keeps events for which the condition is true', async () => {
    const { transform, harness } = await buildTransform(filterTransform, {
      condition: '.status < 400',
    });
    transform.process([logEvent({ status: 200 }), logEvent({ status: 500 })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect((harness.pushed[0]!.event as LogEvent).get('status')).toBe(200n);
  });

  it('drops non-matching events, finished delivered', async () => {
    const { transform, harness } = await buildTransform(filterTransform, {
      condition: '.status < 400',
    });
    const events = [logEvent({ status: 500 })];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('a Failure in the condition falls back through ??, using on_error as the default', async () => {
    // to_bool(...) is a fallible call used directly as the condition; its Failure is caught by
    // the compiled `?? <on_error fallback>`, becoming an ordinary bool -- not an abort.
    const { transform, harness } = await buildTransform(filterTransform, {
      condition: 'to_bool(.n)',
      on_error: 'keep',
    });
    transform.process([logEvent({ n: 'not a bool' })], harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('an any-typed mismatch aborts the condition; on_error: drop finishes rejected', async () => {
    const { transform, harness } = await buildTransform(filterTransform, {
      condition: '.enabled', // .enabled is `any`; a non-bool value aborts (if requires bool)
      on_error: 'drop',
    });
    const events = [logEvent({ enabled: 'yes' })]; // string, not bool -> abort
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('rejected');
  });

  it('an any-typed mismatch with on_error: keep pushes the event through', async () => {
    const { transform, harness } = await buildTransform(filterTransform, {
      condition: '.enabled',
      on_error: 'keep',
    });
    transform.process([logEvent({ enabled: 'yes' })], harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('surfaces a compile error as a FerruleError', async () => {
    await expect(buildTransform(filterTransform, { condition: '.a ==' })).rejects.toBeInstanceOf(
      FerruleError,
    );
  });

  it('renders a compile error against the condition text, not the synthetic wrapper', async () => {
    // `condition` is compiled inside `if !((<condition>) ?? <fallback>) { drop }`; the rendered
    // code frame must show the user's own condition (with the caret under the right token in
    // it), not an offset into that wrapper program.
    const condition = '.status == "bad"';
    let message: string | undefined;
    try {
      await buildTransform(filterTransform, { condition, input_schema: { status: 'int' } });
    } catch (err) {
      expect(err).toBeInstanceOf(FerruleError);
      message = (err as FerruleError).message;
    }
    expect(message).toBeDefined();
    // The source line shown is exactly the condition, not `if !((.status == "bad") ?? ...`.
    expect(message).toContain(`| ${condition}\n`);
    expect(message).not.toContain('if !((');
    expect(message).not.toContain('{ drop }');
    // Position and caret are relative to the condition text alone: it starts at column 1 and the
    // caret underlines the whole (1-indexed length 17) comparison expression.
    expect(message).toContain('<filter condition>:1:1');
    expect(message).toContain(`| ${'^'.repeat(condition.length)} `);
  });

  it('input_schema types the condition', async () => {
    // `.status` typed as `string`: comparing to an int literal is a checker error (E301).
    await expect(
      buildTransform(filterTransform, {
        condition: '.status < 400',
        input_schema: { status: 'string' },
      }),
    ).rejects.toBeInstanceOf(FerruleError);
  });

  it('has no declared output ports', () => {
    expect(filterTransform.outputs).toBeUndefined();
  });
});
