import { describe, expect, it } from 'vitest';
import { s } from '@ferrule/schema';
import { LogEvent, type Event } from '@ferrule/core';
import {
  ManualClock,
  Pipeline,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  defineTransform,
  type TopologySpec,
} from '@ferrule/runtime';
import { basicTransformDefinition, createRegistry } from './fixtures.js';

/**
 * Covers the asynchronous transform contract (`processAsync`) end to end: ordering,
 * backpressure, shutdown-deadline behaviour, and hot reload, all driven by a `ManualClock` so
 * nothing here depends on real wall-clock timing. `component.test.ts`-style unit coverage of the
 * contract validation itself lives in `topology.test.ts`.
 */

function messagesOf(events: readonly Event[]): string[] {
  return events.map((e) => (e as LogEvent).get('message') as string);
}

describe('asynchronous transform contract', () => {
  it('processes batches from one input strictly in order, never overlapping', async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const serializing = defineTransform({
      kind: 'transform',
      type: 'async_order',
      description: 'records call order and overlap, for ordering tests',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        processAsync: async (events, out) => {
          const label = messagesOf(events).join(',');
          active++;
          maxActive = Math.max(maxActive, active);
          calls.push(`start:${label}`);
          // Yield at least once, so a bug that lets the next batch start early has a window in
          // which to actually do so.
          await Promise.resolve();
          await Promise.resolve();
          calls.push(`end:${label}`);
          active--;
          for (const event of events) out.push(event);
        },
      }),
    });
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
      { events: [LogEvent.fromMessage('b')] },
      { events: [LogEvent.fromMessage('c')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, serializing, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: serializing.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    // Never more than one call in flight at a time...
    expect(maxActive).toBe(1);
    // ...meaning every call's `start` is immediately followed by its own `end` before the next
    // call's `start` (channel delivery may coalesce more than one send into a single batch, so
    // this does not assume one event per call).
    for (let i = 0; i < calls.length; i += 2) {
      const label = calls[i]!.slice('start:'.length);
      expect(calls[i]).toBe(`start:${label}`);
      expect(calls[i + 1]).toBe(`end:${label}`);
    }
    // Flattened in call order, events were processed in exactly the order they were sent.
    const processed = calls
      .filter((c) => c.startsWith('start:'))
      .flatMap((c) => c.slice('start:'.length).split(','));
    expect(processed).toEqual(['a', 'b', 'c']);
    expect(messagesOf(collector.events)).toEqual(['a', 'b', 'c']);
  });

  it('applies backpressure: the next batch is not read until processAsync resolves', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const calls: string[] = [];
    const holding = defineTransform({
      kind: 'transform',
      type: 'async_hold',
      description: 'awaits a shared gate before passing events through, for backpressure tests',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        processAsync: async (events, out) => {
          calls.push(messagesOf(events).join(','));
          await gate;
          for (const event of events) out.push(event);
        },
      }),
    });
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
      { events: [LogEvent.fromMessage('b')] },
      { events: [LogEvent.fromMessage('c')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, holding, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: holding.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
      settings: { defaultChannelCapacityEvents: 1 },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();

    // The first batch is pulled out of the (capacity-1) inbox into processAsync, which is now
    // awaiting the gate; the second batch fills the now-empty inbox; the third batch's send has
    // nowhere to go and blocks for lack of capacity. Observing three pushed completions means the
    // source has reached (and is blocked inside) that third send.
    while (handle.completions.length < 3) await Promise.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(calls).toEqual(['a']);
    let allSent = false;
    void handle.allSent.then(() => {
      allSent = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(allSent).toBe(false);

    releaseGate();
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(messagesOf(collector.events)).toEqual(['a', 'b', 'c']);
  });

  it('a transform implementing both process and processAsync fails to build', async () => {
    const broken = defineTransform({
      kind: 'transform',
      type: 'async_both',
      description: 'implements both, which is invalid',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        process: () => {},
        processAsync: async () => {},
      }),
    });
    const { definition: src } = createScriptedSourceDefinition([]);
    const registry = createRegistry(src, broken);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: broken.type, options: {}, inputs: ['in'] } },
      sinks: {},
    };
    await expect(Pipeline.create(spec, { registry })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'E_TRANSFORM_CONTRACT', componentId: 't' })],
    });
  });

  it('a transform implementing neither process nor processAsync fails to build', async () => {
    const broken = defineTransform({
      kind: 'transform',
      type: 'async_neither',
      description: 'implements neither, which is invalid',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({}),
    });
    const { definition: src } = createScriptedSourceDefinition([]);
    const registry = createRegistry(src, broken);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: broken.type, options: {}, inputs: ['in'] } },
      sinks: {},
    };
    await expect(Pipeline.create(spec, { registry })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'E_TRANSFORM_CONTRACT', componentId: 't' })],
    });
  });

  it('respects ctx.signal inside processAsync, so a stuck batch is force-finalized at the shutdown deadline', async () => {
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const stuck = defineTransform({
      kind: 'transform',
      type: 'async_stuck',
      description: 'never resolves on its own; only responds to cancellation',
      options: s.object({}),
      accepts: ['log'],
      build: () => {
        let signal: AbortSignal | undefined;
        return {
          start: (ctx) => {
            signal = ctx.signal;
          },
          processAsync: (events) =>
            new Promise<void>((resolve) => {
              const finish = (): void => {
                for (const event of events) event.metadata.finalizers.finish('errored');
                resolve();
              };
              if (signal?.aborted === true) {
                finish();
                return;
              }
              signal?.addEventListener('abort', finish, { once: true });
            }),
        };
      },
    });
    const registry = createRegistry(src, stuck);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: stuck.type, options: {}, inputs: ['in'] } },
      sinks: {},
      settings: { shutdownDeadlineMs: 50 },
    };
    const pipeline = await Pipeline.create(spec, { registry, clock });
    await pipeline.start();
    await handle.allSent;

    const stopPromise = pipeline.stop();
    await clock.advance(50);
    await stopPromise;

    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('errored');
    expect(pipeline.health().overall).toBe('stopped');
  });

  it("drives a transform's tick() and flush() only after an in-flight processAsync call resolves", async () => {
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const order: string[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const transform = defineTransform({
      kind: 'transform',
      type: 'async_tick',
      description: 'holds process behind a gate; tick/flush must wait for it',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        tickIntervalMs: 10,
        processAsync: async (events, out) => {
          order.push('process:start');
          await gate;
          order.push('process:end');
          for (const event of events) out.push(event);
        },
        tick: () => {
          order.push('tick');
        },
        flush: () => {
          order.push('flush');
        },
      }),
    });
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, transform, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: transform.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry, clock });
    await pipeline.start();
    await handle.allSent;
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The tick interval has elapsed, but process() is still holding the mutex: tick() must not
    // have run yet.
    await clock.advance(10);
    expect(order).toEqual(['process:start']);

    releaseGate();
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(order[0]).toBe('process:start');
    expect(order[1]).toBe('process:end');
    expect(order).toContain('flush');
    expect(order.indexOf('flush')).toBe(order.length - 1);
    expect(messagesOf(collector.events)).toEqual(['a']);
  });

  it('a changed async transform finishes its in-flight batch while the new instance takes new work', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const before = defineTransform({
      kind: 'transform',
      type: 'async_before',
      description: 'awaits a gate before passing events through, for reload tests',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        processAsync: async (events, out) => {
          await gate;
          for (const event of events) out.push(event);
        },
      }),
    });
    const after = basicTransformDefinition('async_after');
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('before')] },
      { events: [LogEvent.fromMessage('after')], delayMs: 100 },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, before, after, snk);
    const clock = new ManualClock();
    const specA: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: before.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(specA, { registry, clock });
    await pipeline.start();

    // Let the source send its first (undelayed) step and the transform pick it up into
    // processAsync, where it is now stuck on the gate; the second step is still waiting on its
    // 100ms delay, so it has not reached the transform at all yet.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const specB: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: after.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const result = await pipeline.reload(specB);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toEqual(['t']);

    // The retired instance is still draining in the background, holding 'before' in flight
    // inside processAsync; releasing the gate lets it finish and push its event downstream, same
    // as any other retiring component.
    releaseGate();
    await clock.advance(100); // lets the source send its second step, now routed to the new instance
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(messagesOf(collector.events).sort()).toEqual(['after', 'before']);
  });
});
