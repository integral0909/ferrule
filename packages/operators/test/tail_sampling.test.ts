import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FerruleError } from '@ferrule/core';
import { tailSamplingTransform } from '@ferrule/operators';
import { buildTransform, sealedBatch, spanEvent } from './helpers.js';

describe('tail_sampling', () => {
  it('with no policies, samples every trace once decided', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      decision_wait: 1000,
    });
    const root = spanEvent({ traceId: 1, spanId: 1 });
    transform.process([root], harness.out);
    expect(harness.pushed).toHaveLength(0);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('status_error policy samples a trace containing an error span', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'status_error' }],
    });
    const root = spanEvent({ traceId: 1, spanId: 1, status: 'ok' });
    const child = spanEvent({ traceId: 1, spanId: 2, parentSpanId: 1, status: 'error' });
    transform.process([root, child], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('without a matching policy, the trace is dropped and finalizers finish as delivered', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'status_error' }],
    });
    const root = spanEvent({ traceId: 1, spanId: 1, status: 'ok' });
    const batch = sealedBatch([root]);
    transform.process([root], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('latency policy samples on root span duration', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'latency', threshold: 500, scope: 'root' }],
    });
    const slow = spanEvent({ traceId: 1, spanId: 1, durationNanos: 600_000_000n });
    transform.process([slow], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('attribute policy matches on a span attribute', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [
        {
          type: 'attribute',
          condition: { type: 'field_equals', field: 'attributes.http.status_code', value: 500 },
        },
      ],
    });
    const span = spanEvent({ traceId: 1, spanId: 1, attributes: { http: { status_code: 500 } } });
    transform.process([span], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('script policy samples a trace whose span matches the expression', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'script', condition: '.attributes.http_status_code == 500' }],
    });
    const span = spanEvent({ traceId: 1, spanId: 1, attributes: { http_status_code: 500 } });
    transform.process([span], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('script policy with scope: root only evaluates the root span', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'script', condition: '.name == "child"', scope: 'root' }],
    });
    const root = spanEvent({ traceId: 1, spanId: 1, name: 'root' });
    const child = spanEvent({ traceId: 1, spanId: 2, parentSpanId: 1, name: 'child' });
    const batch = sealedBatch([root, child]);
    transform.process([root, child], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(0); // the root doesn't match; the child is out of scope
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('script policy without a matching span does not sample the trace', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'script', condition: '.attributes.http_status_code == 500' }],
    });
    const span = spanEvent({ traceId: 1, spanId: 1, attributes: { http_status_code: 200 } });
    const batch = sealedBatch([span]);
    transform.process([span], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('rejects a type error in a script policy condition as a build-time compile error', async () => {
    await expect(
      buildTransform(tailSamplingTransform, {
        quiet_period: 100,
        policies: [{ type: 'script', condition: '.name < 1' }], // .name is string, not int
      }),
    ).rejects.toBeInstanceOf(FerruleError);
  });

  it('script policy composes with the declarative policies via or', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [
        {
          type: 'or',
          policies: [
            { type: 'status_error' },
            { type: 'script', condition: '.attributes.slow == true' },
          ],
        },
      ],
    });
    const span = spanEvent({ traceId: 1, spanId: 1, status: 'ok', attributes: { slow: true } });
    transform.process([span], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('or composes policies: sampled if either matches', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [
        {
          type: 'or',
          policies: [{ type: 'status_error' }, { type: 'latency', threshold: 1, scope: 'any' }],
        },
      ],
    });
    const slow = spanEvent({ traceId: 1, spanId: 1, durationNanos: 5_000_000n, status: 'ok' });
    transform.process([slow], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);
  });

  it('probabilistic sampling is deterministic per trace ID', async () => {
    const decide = async (rate: number) => {
      const { transform, harness } = await buildTransform(tailSamplingTransform, {
        quiet_period: 100,
        policies: [{ type: 'probabilistic', rate }],
      });
      const span = spanEvent({ traceId: 42, spanId: 1 });
      transform.process([span], harness.out);
      await harness.clock.advance(100);
      transform.tick!(harness.clock.now(), harness.out);
      return harness.pushed.length === 1;
    };
    const first = await decide(0.5);
    const second = await decide(0.5);
    expect(first).toBe(second);
  });

  it('decides once, quiet_period-driven, root seen resets the countdown from the last span', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      decision_wait: 10_000,
    });
    const root = spanEvent({ traceId: 1, spanId: 1 });
    transform.process([root], harness.out);
    await harness.clock.advance(50);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(0); // quiet period not yet elapsed

    const child = spanEvent({ traceId: 1, spanId: 2, parentSpanId: 1 });
    transform.process([child], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(2); // both spans flushed together
  });

  it('a late span for an already-decided trace follows the cached decision', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 100,
      policies: [{ type: 'status_error' }],
    });
    const root = spanEvent({ traceId: 1, spanId: 1, status: 'error' });
    transform.process([root], harness.out);
    await harness.clock.advance(100);
    transform.tick!(harness.clock.now(), harness.out);
    expect(harness.pushed).toHaveLength(1);

    const late = spanEvent({ traceId: 1, spanId: 2, parentSpanId: 1, status: 'ok' });
    transform.process([late], harness.out);
    expect(harness.pushed).toHaveLength(2); // followed the cached "sampled" decision immediately
  });

  it('max_spans_per_trace forces an early decision without losing spans', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 10_000,
      max_spans_per_trace: 2,
    });
    const spans = [1, 2, 3].map((i) =>
      i === 1
        ? spanEvent({ traceId: 1, spanId: i })
        : spanEvent({ traceId: 1, spanId: i, parentSpanId: 1 }),
    );
    transform.process(spans, harness.out);
    // No policies configured => samples everything; every span reaches the output, none lost.
    expect(harness.pushed).toHaveLength(3);
  });

  it('max_traces evicts the least-recently-active trace via an early decision', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 10_000,
      max_traces: 1,
    });
    const a = spanEvent({ traceId: 1, spanId: 1 });
    const b = spanEvent({ traceId: 2, spanId: 1 });
    transform.process([a], harness.out);
    transform.process([b], harness.out); // evicts trace 1's buffer via a forced decision
    expect(harness.pushed).toHaveLength(1); // trace 1's span, decided and flushed
  });

  it('flush() decides and flushes every buffered trace at shutdown', async () => {
    const { transform, harness } = await buildTransform(tailSamplingTransform, {
      quiet_period: 10_000,
    });
    transform.process(
      [spanEvent({ traceId: 1, spanId: 1 }), spanEvent({ traceId: 2, spanId: 1 })],
      harness.out,
    );
    transform.flush!(harness.out);
    expect(harness.pushed).toHaveLength(2);
  });

  it('property: the decision for a trace ID is consistent across repeated evaluations', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (traceId, rate) => {
          const results: boolean[] = [];
          for (let i = 0; i < 3; i++) {
            const { transform, harness } = await buildTransform(tailSamplingTransform, {
              quiet_period: 10,
              policies: [{ type: 'probabilistic', rate }],
            });
            transform.process([spanEvent({ traceId, spanId: 1 })], harness.out);
            await harness.clock.advance(10);
            transform.tick!(harness.clock.now(), harness.out);
            results.push(harness.pushed.length === 1);
          }
          expect(new Set(results).size).toBe(1);
        },
      ),
      { numRuns: 20 },
    );
  });
});
