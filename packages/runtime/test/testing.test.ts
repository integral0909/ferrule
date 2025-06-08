import { describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import {
  DEFAULT_PORT,
  createCapturingLogger,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  createTestSinkContext,
  createTestSourceContext,
  createTestTransformContext,
} from '@ferrule/runtime';

describe('createCapturingLogger', () => {
  it('records level, message, and merged fields, including from child loggers', () => {
    const { logger, records } = createCapturingLogger();
    logger.info('a');
    logger.child({ component: 'x' }).warn('b', { extra: 1 });
    expect(records).toEqual([
      { level: 'info', message: 'a', fields: {} },
      { level: 'warn', message: 'b', fields: { component: 'x', extra: 1 } },
    ]);
  });
});

describe('createTestSourceContext', () => {
  it('lets a source under test call ctx.output.send and records every call', async () => {
    const harness = createTestSourceContext({ id: 'my-source' });
    expect(harness.ctx.id).toBe('my-source');
    await harness.ctx.output.send(LogEvent.fromMessage('hi'), 'errors');
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.port).toBe('errors');
  });

  it('provides an independent ManualClock and MetricsRegistry', () => {
    const harness = createTestSourceContext();
    harness.ctx.metrics.counter('x').increment();
    expect(harness.metrics.snapshot()).toHaveLength(1);
    expect(harness.clock.monotonic()).toBe(0);
  });

  it('abort() aborts ctx.signal', () => {
    const harness = createTestSourceContext();
    expect(harness.ctx.signal.aborted).toBe(false);
    harness.abort();
    expect(harness.ctx.signal.aborted).toBe(true);
  });
});

describe('createTestTransformContext', () => {
  it('records events pushed through out.push', () => {
    const harness = createTestTransformContext();
    harness.out.push(LogEvent.fromMessage('a'));
    harness.out.push(LogEvent.fromMessage('b'), 'errors');
    expect(harness.pushed.map((p) => p.port)).toEqual([DEFAULT_PORT, 'errors']);
  });
});

describe('createTestSinkContext', () => {
  it('feeds ctx.input from a manual queue and supports close()', async () => {
    const harness = createTestSinkContext();
    const batches: unknown[] = [];
    const consumed = (async () => {
      for await (const batch of harness.ctx.input) batches.push(batch);
    })();
    await harness.feed(LogEvent.fromMessage('a'));
    harness.close();
    await consumed;
    expect(batches).toHaveLength(1);
  });
});

describe('createCollectingSinkDefinition', () => {
  it('collects every event and batch it receives', async () => {
    const { definition, collector } = createCollectingSinkDefinition();
    const sink = await definition.build(
      {},
      { id: 's', logger: createCapturingLogger().logger, dataDir: undefined, inputs: [] },
    );
    const harness = createTestSinkContext();
    const running = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('a'), LogEvent.fromMessage('b')]);
    harness.close();
    await running;
    expect(collector.events).toHaveLength(2);
    expect(collector.batches).toHaveLength(1);
  });

  it('finishes finalizers with a caller-controlled status', async () => {
    const { definition } = createCollectingSinkDefinition({ finish: () => 'rejected' });
    const sink = await definition.build(
      {},
      { id: 's', logger: createCapturingLogger().logger, dataDir: undefined, inputs: [] },
    );
    const harness = createTestSinkContext();
    const running = sink.run(harness.ctx);
    const event = LogEvent.fromMessage('a');
    await harness.feed([event]);
    harness.close();
    await running;
    expect(event.metadata.finalizers.isEmpty).toBe(true);
  });
});

describe('createScriptedSourceDefinition', () => {
  it("sends every scripted step and reports each batch's completion status", async () => {
    const { definition, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
      { events: [LogEvent.fromMessage('b')] },
    ]);
    const source = await definition.build(
      {},
      { id: 's', logger: createCapturingLogger().logger, dataDir: undefined, inputs: [] },
    );
    const harness = createTestSourceContext();
    const running = source.run(harness.ctx);
    await handle.allSent;
    expect(harness.sent).toHaveLength(2);
    for (const event of harness.sent.flatMap((s) => s.events)) {
      event.metadata.finalizers.finish('delivered');
    }
    await Promise.all(handle.completions);
    harness.abort();
    await running;
  });
});
