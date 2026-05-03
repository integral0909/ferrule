import { describe, expect, it } from 'vitest';
import { FerruleError, isMetricEvent, MetricEvent, type Event } from '@ferrule/core';
import type { BuildContext, MetricsRecorder, SourceContext } from '@ferrule/runtime';
import { createCapturingLogger, ManualClock } from '@ferrule/runtime';
import { internalMetricsSource, type InternalMetricsOptions } from '../src/internal_metrics.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';

function buildCtx(): BuildContext {
  const { logger } = createCapturingLogger();
  return { id: 'im', logger, dataDir: undefined, inputs: [] };
}

function parse(raw: Record<string, unknown> = {}): InternalMetricsOptions {
  return internalMetricsSource.options.parse(raw);
}

describe('internal_metrics: declared shape', () => {
  it('produces metric events only', () => {
    expect(internalMetricsSource.produces(parse())).toEqual(['metric']);
  });
});

describe('internal_metrics: emission timing', () => {
  it('emits nothing before the first interval elapses, then a snapshot per tick', async () => {
    const opts = parse({ interval: 1000 });
    const handle = await internalMetricsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    harness.metrics.counter('widgets_total').increment(5);
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.clock.pendingCount === 1);
    expect(harness.sent).toHaveLength(0);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    const widget = events.find((e) => e.name === 'widgets_total');
    expect(widget).toBeDefined();
    expect(widget!.value).toEqual({ type: 'counter', value: 5 });

    harness.abort();
    await runPromise;
  });

  it('skips a tick with nothing recorded rather than sending an empty batch', async () => {
    const opts = parse({ interval: 1000 });
    const handle = await internalMetricsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.clock.pendingCount === 1); // already waiting on the next tick
    expect(harness.sent).toHaveLength(0);

    harness.abort();
    await runPromise;
  });
});

describe('internal_metrics: namespace_override', () => {
  function fakeMetricsWithSnapshot(events: readonly MetricEvent[]): MetricsRecorder {
    return {
      counter: () => ({ increment: () => {} }),
      gauge: () => ({ set: () => {}, add: () => {} }),
      histogram: () => ({ record: () => {} }),
      snapshot: () => events.map((e) => e.clone()),
    };
  }

  it('replaces series.namespace on every emitted metric when set', async () => {
    const canned = [
      new MetricEvent({
        name: 'reqs_total',
        namespace: 'original',
        kind: 'absolute',
        value: { type: 'counter', value: 3 },
      }),
    ];
    const opts = parse({ interval: 1000, namespace_override: 'ferrule' });
    const handle = await internalMetricsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const ctx: SourceContext = { ...harness.ctx, metrics: fakeMetricsWithSnapshot(canned) };
    const runPromise = handle.run(ctx);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 1);
    const [event] = harness.sent[0]!.events as MetricEvent[];
    expect(event!.series.namespace).toBe('ferrule');
    expect(event!.name).toBe('reqs_total'); // the name itself is left untouched

    harness.abort();
    await runPromise;
  });

  it('leaves the namespace as recorded when unset', async () => {
    const canned = [
      new MetricEvent({
        name: 'reqs_total',
        namespace: 'original',
        kind: 'absolute',
        value: { type: 'counter', value: 3 },
      }),
    ];
    const opts = parse({ interval: 1000 });
    const handle = await internalMetricsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const ctx: SourceContext = { ...harness.ctx, metrics: fakeMetricsWithSnapshot(canned) };
    const runPromise = handle.run(ctx);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 1);
    const [event] = harness.sent[0]!.events as MetricEvent[];
    expect(event!.series.namespace).toBe('original');

    harness.abort();
    await runPromise;
  });
});

describe('internal_metrics: fails fast without ctx.metrics.snapshot', () => {
  function createContextWithoutSnapshot(): SourceContext {
    const { logger } = createCapturingLogger();
    const metrics: MetricsRecorder = {
      counter: () => ({ increment: () => {} }),
      gauge: () => ({ set: () => {}, add: () => {} }),
      histogram: () => ({ record: () => {} }),
      // `snapshot` deliberately omitted: this is the case the source must reject, not hang on.
    };
    const send = (_events: Event | readonly Event[]): Promise<void> => Promise.resolve();
    return {
      id: 'im',
      type: 'internal_metrics',
      kind: 'source',
      logger,
      metrics,
      clock: new ManualClock(),
      signal: new AbortController().signal,
      dataDir: undefined,
      acknowledgements: true,
      output: { send },
    };
  }

  it('rejects run() with a FerruleError instead of hanging or no-oping', async () => {
    const opts = parse();
    const handle = await internalMetricsSource.build(opts, buildCtx());
    const ctx = createContextWithoutSnapshot();
    await expect(handle.run(ctx)).rejects.toThrow(FerruleError);
  });
});

describe('internal_metrics: graceful shutdown', () => {
  it('stops emitting and lets run() resolve promptly once ctx.signal aborts', async () => {
    const opts = parse({ interval: 1000 });
    const handle = await internalMetricsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    harness.metrics.counter('widgets_total').increment(1);
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.clock.pendingCount === 1);
    harness.abort();
    await runPromise; // must not hang on the pending sleep

    await harness.clock.advance(5000);
    expect(harness.sent).toHaveLength(0);
  });
});
