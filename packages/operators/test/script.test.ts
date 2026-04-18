import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
import { FerruleError, MetricEvent } from '@ferrule/core';
import { scriptTransform } from '@ferrule/operators';
import { buildTransform, counterMetric, logEvent, sealedBatch } from './helpers.js';

describe('script', () => {
  it('runs a compiled program that mutates fields', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: '.level = upcase(.level) ?? "unknown"',
    });
    transform.process([logEvent({ level: 'info' })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect((harness.pushed[0]!.event as LogEvent).get('level')).toBe('INFO');
    expect(harness.pushed[0]!.port).toBe('_default');
  });

  it('rejects source and file both given, and neither given', () => {
    expect(() => scriptTransform.options.parse({ source: 'x', file: 'y' })).toThrow();
    expect(() => scriptTransform.options.parse({})).toThrow();
  });

  it('reads source from a file at build time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferrule-script-test-'));
    const file = join(dir, 'transform.fer');
    writeFileSync(file, '.from_file = true\n');
    const { transform, harness } = await buildTransform(scriptTransform, { file });
    transform.process([logEvent({})], harness.out);
    expect((harness.pushed[0]!.event as LogEvent).get('from_file')).toBe(true);
  });

  it('surfaces a compile error as a FerruleError with a rendered code frame', async () => {
    await expect(buildTransform(scriptTransform, { source: '.a = ' })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(FerruleError);
        expect((error as FerruleError).message).toContain('script failed to compile');
        return true;
      },
    );
  });

  it('a missing script file fails at build time with a clear message', async () => {
    await expect(
      buildTransform(scriptTransform, { file: '/nonexistent/path/to/script.fer' }),
    ).rejects.toBeInstanceOf(FerruleError);
  });

  it('input_schema narrows a field so a mismatched use is a build-time compile error', async () => {
    await expect(
      buildTransform(scriptTransform, {
        source: '.n = .status + 1',
        input_schema: { status: 'string' },
      }),
    ).rejects.toBeInstanceOf(FerruleError);
  });

  it('drop: finishes the event delivered by default', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'if .skip == true { drop }',
    });
    const events = [logEvent({ skip: true })];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('reroute_dropped sends dropped events to the dropped port instead', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'if .skip == true { drop }',
      reroute_dropped: true,
    });
    transform.process([logEvent({ skip: true })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('dropped');
  });

  it('abort: routes to the errors port with ferrule.error metadata attached by default', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'abort "bad thing happened"',
    });
    transform.process([logEvent({})], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('errors');
    const out = harness.pushed[0]!.event as LogEvent;
    expect(out.get('ferrule.error.reason')).toBe('bad thing happened');
    expect(out.get('ferrule.error.transform')).toBe(harness.ctx.id);
    expect(typeof out.get('ferrule.error.span.start')).toBe('bigint');
  });

  it('drop_on_abort finishes rejected and does not route to errors', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'abort "nope"',
      drop_on_abort: true,
    });
    const events = [logEvent({})];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('rejected');
  });

  it('drop_on_error alone does not suppress a deliberate abort', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'abort "deliberate"',
      drop_on_error: true,
    });
    transform.process([logEvent({})], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('errors');
  });

  it('drop_on_error drops a resource-limit abort', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'let s = "xx"\nlet r = repeat(s, 100) ?? ""\n.out = r',
      limits: { max_string_length: 2 },
      drop_on_error: true,
    });
    const events = [logEvent({})];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('rejected');
  });

  it('drop_on_abort alone does not suppress a resource-limit abort', async () => {
    // The two flags key off Outcome.cause (a structured field in @ferrule/script), not off
    // matching text in the reason string: drop_on_abort must not accidentally catch a `limit`
    // cause, only an `abort` one.
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'let s = "xx"\nlet r = repeat(s, 100) ?? ""\n.out = r',
      limits: { max_string_length: 2 },
      drop_on_abort: true,
    });
    transform.process([logEvent({})], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('errors');
    const out = harness.pushed[0]!.event as LogEvent;
    expect(out.get('ferrule.error.reason')).toContain('limit exceeded');
  });

  it('emit(): extra events get cloned finalizers so the batch only acks once all finish', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: 'emit({ "extra": true })',
    });
    const events = [logEvent({ original: true })];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(2);
    expect((harness.pushed[0]!.event as LogEvent).get('original')).toBe(true);
    expect((harness.pushed[1]!.event as LogEvent).get('extra')).toBe(true);

    // Finish only the original; the batch must still be pending on the emitted copy.
    harness.pushed[0]!.event.metadata.finalizers.finish('delivered');
    let settled = false;
    void batch.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.pushed[1]!.event.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('metric and span events pass through unchanged (identity preserved)', async () => {
    const { transform, harness } = await buildTransform(scriptTransform, {
      source: '.untouched = true',
    });
    const metric = counterMetric('requests', 1);
    transform.process([metric], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.event).toBe(metric);
    expect(harness.pushed[0]!.event).toBeInstanceOf(MetricEvent);
    expect(harness.pushed[0]!.port).toBe('_default');
  });

  it('declares the dropped port only when reroute_dropped is set', () => {
    const on = scriptTransform.options.parse({ source: '.x = 1', reroute_dropped: true });
    const off = scriptTransform.options.parse({ source: '.x = 1' });
    expect(scriptTransform.outputs?.(on).map((p) => p.name)).toEqual(['errors', 'dropped']);
    expect(scriptTransform.outputs?.(off).map((p) => p.name)).toEqual(['errors']);
  });
});
