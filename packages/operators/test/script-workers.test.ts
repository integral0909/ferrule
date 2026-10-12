import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toPlain, type Event, type LogEvent } from '@ferrule/core';
import {
  createTestTransformContext,
  type TransformContext,
  type TransformOutput,
  type TestTransformHarness,
} from '@ferrule/runtime';
import { scriptTransform, type ScriptOptions } from '@ferrule/operators';
import { counterMetric, logEvent, sealedBatch } from './helpers.js';

/**
 * Covers the `script` transform's `workers: <n>` option: chunking a batch across a real
 * `WorkerPool`, and reattaching outcomes to the original events by position. `script.test.ts`
 * covers the in-thread path (`workers: 0`, unchanged); `@ferrule/runtime`'s own
 * `worker-pool.test.ts` covers `WorkerPool`'s crash/retry/backpressure mechanics directly — this
 * file only has to show `script.ts` wires into them correctly, plus (the main point) that the
 * results match the in-thread path exactly.
 *
 * These tests spin up real `worker_threads` workers, running the *built* `dist/worker/
 * script-worker-entry.js` (see `resolveWorkerEntry` in `@ferrule/runtime`'s README) — the test
 * suite's `globalSetup` (`vitest.global-setup.ts`) builds it first. They are slower than the
 * rest of the suite but exercise the exact same code path production does.
 */

interface BuiltWorkerTransform {
  readonly transform: {
    readonly start?: (ctx: TransformContext) => void;
    readonly processAsync: (events: Event[], out: TransformOutput) => Promise<void>;
    readonly flush: (out: TransformOutput) => Promise<void>;
  };
  readonly harness: TestTransformHarness;
}

async function buildWorkerTransform(
  rawOptions: Partial<ScriptOptions> & { workers: number },
): Promise<BuiltWorkerTransform> {
  const options = scriptTransform.options.parse(rawOptions);
  const harness = createTestTransformContext();
  const transform = await scriptTransform.build(options, {
    id: harness.ctx.id,
    logger: harness.ctx.logger,
    dataDir: harness.ctx.dataDir,
    inputs: [],
  });
  transform.start?.(harness.ctx);
  if (transform.processAsync === undefined) {
    throw new Error('buildWorkerTransform: expected a processAsync-based transform');
  }
  return { transform: transform as BuiltWorkerTransform['transform'], harness };
}

describe('script: workers > 0', () => {
  it('mutates fields across worker threads the same way the in-thread path does', async () => {
    const { transform, harness } = await buildWorkerTransform({
      source: '.level = upcase(.level) ?? "unknown"',
      workers: 2,
    });
    const events = [logEvent({ level: 'info' }), logEvent({ level: 'warn' })];
    await transform.processAsync(events, harness.out);
    await transform.flush(harness.out);

    expect(harness.pushed).toHaveLength(2);
    expect((harness.pushed[0]!.event as LogEvent).get('level')).toBe('INFO');
    expect((harness.pushed[1]!.event as LogEvent).get('level')).toBe('WARN');
    // The original event objects (and so their finalizers) are reused, not replaced.
    expect(harness.pushed[0]!.event).toBe(events[0]);
    expect(harness.pushed[1]!.event).toBe(events[1]);
  });

  it('drop: finishes the event delivered by default, same as in-thread', async () => {
    const { transform, harness } = await buildWorkerTransform({ source: 'drop', workers: 2 });
    const events = [logEvent({})];
    const batch = sealedBatch(events);
    await transform.processAsync(events, harness.out);
    await transform.flush(harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('abort: attaches ferrule.error.* to the original event and routes to errors', async () => {
    const { transform, harness } = await buildWorkerTransform({
      source: 'abort "boom"',
      workers: 2,
    });
    const events = [logEvent({ original: true })];
    await transform.processAsync(events, harness.out);
    await transform.flush(harness.out);

    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('errors');
    const out = harness.pushed[0]!.event as LogEvent;
    expect(out).toBe(events[0]); // same object, real finalizers intact
    expect(out.get('ferrule.error.reason')).toBe('boom');
    expect(out.get('original')).toBe(true);
  });

  it('emit(): extra events get cloned finalizers so the batch only acks once all finish', async () => {
    const { transform, harness } = await buildWorkerTransform({
      source: 'emit({ "extra": true })',
      workers: 2,
    });
    const events = [logEvent({ original: true })];
    const batch = sealedBatch(events);
    await transform.processAsync(events, harness.out);
    await transform.flush(harness.out);

    expect(harness.pushed).toHaveLength(2);
    expect((harness.pushed[0]!.event as LogEvent).get('original')).toBe(true);
    expect((harness.pushed[1]!.event as LogEvent).get('extra')).toBe(true);
    expect(harness.pushed[0]!.event).toBe(events[0]);

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

  it('metric and span events pass through unchanged (identity preserved, no chunking)', async () => {
    const { transform, harness } = await buildWorkerTransform({
      source: '.untouched = true',
      workers: 2,
    });
    const metric = counterMetric('requests', 1);
    await transform.processAsync([metric], harness.out);
    await transform.flush(harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.event).toBe(metric);
  });

  it('a chunk still queued when the pipeline aborts finishes its events errored, not hung', async () => {
    const { transform, harness } = await buildWorkerTransform({
      source: '.seen = true',
      workers: 1, // a single worker, so the second processAsync's chunk must queue behind the first
    });
    const firstEvents = [logEvent({ which: 'first' })];
    const secondEvents = [logEvent({ which: 'second' })];
    const secondBatch = sealedBatch(secondEvents);

    const first = transform.processAsync(firstEvents, harness.out);
    // Give the first chunk a moment to actually be dispatched to the (only) worker before the
    // second one is submitted, so the second is guaranteed to still be queued when we abort.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = transform.processAsync(secondEvents, harness.out);
    await new Promise((resolve) => setTimeout(resolve, 5));

    harness.abort(new Error('pipeline shutting down'));
    await Promise.all([first, second]);
    await transform.flush(harness.out);

    await expect(secondBatch.completion).resolves.toBe('errored');
  });

  it('matches the in-thread path exactly for a corpus of programs (property test)', async () => {
    // Each run builds a real WorkerPool (3 worker_threads) and tears it down again, so this is
    // slow per-iteration compared to a typical property test; numRuns/timeout are scaled down
    // accordingly rather than left at the suite defaults.
    const programs = [
      '.level = upcase(.level) ?? .level',
      '.n = to_int(.n) ?? 0\n.n = .n + 1',
      'if (to_int(.n) ?? 0) > 50 { .big = true } else { .big = false }',
      'if .level == "debug" { drop }',
      'if (to_int(.n) ?? 0) < 0 { abort "negative" }',
      '.tags = filter(.tags, |t| is_string(t)) ?? []',
      'emit({ "copy": true })\n.original = true',
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...programs),
        fc.array(
          fc.record({
            level: fc.constantFrom('info', 'warn', 'debug', 'error'),
            n: fc.integer({ min: -5, max: 100 }),
            tags: fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 3 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (source, records) => {
          // `workers: 0` returns a `process`-based transform, so it is built directly here
          // rather than through `buildWorkerTransform` (which asserts `processAsync`).
          const inThreadOptions = scriptTransform.options.parse({ source, workers: 0 });
          const inThreadHarness = createTestTransformContext();
          const inThreadTransform = await scriptTransform.build(inThreadOptions, {
            id: inThreadHarness.ctx.id,
            logger: inThreadHarness.ctx.logger,
            dataDir: inThreadHarness.ctx.dataDir,
            inputs: [],
          });
          inThreadTransform.start?.(inThreadHarness.ctx);
          const inThreadEvents = records.map((r) => logEvent(r));
          inThreadTransform.process!(inThreadEvents, inThreadHarness.out);

          const { transform, harness } = await buildWorkerTransform({ source, workers: 3 });
          const workerEvents = records.map((r) => logEvent(r));
          await transform.processAsync(workerEvents, harness.out);
          await transform.flush(harness.out);

          const summarize = (pushed: TestTransformHarness['pushed']): unknown[] =>
            pushed.map((p) => ({
              port: p.port,
              fields: toPlain((p.event as LogEvent).fields, { integers: 'string' }),
            }));

          expect(summarize(harness.pushed)).toEqual(summarize(inThreadHarness.pushed));
        },
      ),
      { numRuns: 15 },
    );
  }, 30_000);
});
