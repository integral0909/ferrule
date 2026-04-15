import { describe, expect, it } from 'vitest';
import { s } from '@ferrule/schema';
import { LogEvent } from '@ferrule/core';
import {
  ManualClock,
  Pipeline,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  defineSink,
  type TopologySpec,
} from '@ferrule/runtime';
import { createRegistry } from './fixtures.js';

let globalGeneration = 0;

/**
 * A sink that tags every event it delivers with the generation of the `build()` call that
 * produced its running instance, and can be gated so events accumulate before it starts
 * consuming. Used to tell whether the pipeline kept an existing instance running across a
 * reload or replaced it with a freshly built one.
 */
function gatedTaggedSinkDefinition(type: string): {
  definition: ReturnType<typeof defineSink<{ tag: string }>>;
  received: { generation: number; message: string }[];
  release: () => void;
} {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const received: { generation: number; message: string }[] = [];
  const definition = defineSink({
    kind: 'sink',
    type,
    description: 'tags delivered events with its build generation, for reload tests',
    options: s.object({ tag: s.string().default('x') }),
    accepts: ['log'],
    build: () => {
      const generation = ++globalGeneration;
      return {
        run: async (ctx) => {
          await gate;
          for await (const batch of ctx.input) {
            for (const event of batch) {
              received.push({ generation, message: (event as LogEvent).get('message') as string });
              event.metadata.finalizers.finish('delivered');
            }
          }
        },
      };
    },
  });
  return { definition, received, release: () => releaseGate() };
}

describe('Pipeline.reload', () => {
  it('adds a new sink and immediately routes new events to it', async () => {
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('before')] },
      { events: [LogEvent.fromMessage('after')], delayMs: 100 },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const specA: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(specA, { registry, clock });
    await pipeline.start();

    // Let the first (undelayed) step go out before reloading; the second is still waiting.
    while (handle.completions.length < 1) await Promise.resolve();
    await Promise.all(handle.completions);

    const { definition: added, collector: addedCollector } = createCollectingSinkDefinition({
      type: 'added_sink',
    });
    registry.register(added);
    const specB: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        out: { type: snk.type, options: {}, inputs: ['in'] },
        extra: { type: 'added_sink', options: {}, inputs: ['in'] },
      },
    };
    const result = await pipeline.reload(specB);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.added).toEqual(['extra']);

    await clock.advance(100);
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(collector.events.map((e) => (e as LogEvent).get('message'))).toEqual([
      'before',
      'after',
    ]);
    expect(addedCollector.events.map((e) => (e as LogEvent).get('message'))).toEqual(['after']);
  });

  it('drains and stops a removed sink, which receives nothing further', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('x')] },
    ]);
    const { definition: snk, received, release } = gatedTaggedSinkDefinition('removed_snk');
    const { definition: keep } = createCollectingSinkDefinition({ type: 'keep' });
    const registry = createRegistry(src, snk, keep);
    const specA: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        gone: { type: snk.type, options: { tag: 'a' }, inputs: ['in'] },
        stay: { type: 'keep', options: {}, inputs: ['in'] },
      },
    };
    const pipeline = await Pipeline.create(specA, { registry });
    await pipeline.start();
    await handle.allSent;

    const specB: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { stay: { type: 'keep', options: {}, inputs: ['in'] } },
    };
    const result = await pipeline.reload(specB);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toEqual(['gone']);
    expect(pipeline.snapshot().components.some((c) => c.id === 'gone')).toBe(false);

    release();
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('delivered');
    expect(received.map((r) => r.message)).toEqual(['x']);
    await pipeline.stop();
  });

  it('replaces a changed component: the retiring instance drains, the new one takes new work', async () => {
    const { definition: src1, handle: handle1 } = createScriptedSourceDefinition(
      [{ events: [LogEvent.fromMessage('before')] }],
      { type: 'src1' },
    );
    const { definition: src2, handle: handle2 } = createScriptedSourceDefinition(
      [{ events: [LogEvent.fromMessage('after')] }],
      { type: 'src2' },
    );
    const { definition: snk, received, release } = gatedTaggedSinkDefinition('gated_snk_2');
    const registry = createRegistry(src1, src2, snk);
    const specA: TopologySpec = {
      sources: { in: { type: 'src1', options: {} } },
      sinks: { out: { type: 'gated_snk_2', options: { tag: 'a' }, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(specA, { registry });
    await pipeline.start();
    await handle1.allSent;

    const specB: TopologySpec = {
      sources: { in: { type: 'src1', options: {} }, in2: { type: 'src2', options: {} } },
      sinks: { out: { type: 'gated_snk_2', options: { tag: 'b' }, inputs: ['in', 'in2'] } },
    };
    const result = await pipeline.reload(specB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toEqual(['out']);
      expect(result.added).toEqual(['in2']);
      expect(result.unchanged).toEqual(['in']);
    }

    await handle2.allSent;
    release();
    await Promise.all([...handle1.completions, ...handle2.completions]);
    await pipeline.stop();

    const before = received.find((r) => r.message === 'before');
    const after = received.find((r) => r.message === 'after');
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(before?.generation).not.toBe(after?.generation);
  });

  it('keeps an unchanged component running (same instance) with its buffered events intact', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')] },
    ]);
    const { definition: snk, received, release } = gatedTaggedSinkDefinition('gated_snk_3');
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: 'gated_snk_3', options: { tag: 'same' }, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent; // events now sit in the sink's inbox, unconsumed (gate is closed)

    const result = await pipeline.reload(spec); // byte-identical spec
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.unchanged].sort()).toEqual(['in', 'out']);

    release();
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(received.map((r) => r.message).sort()).toEqual(['a', 'b']);
    // Both events were handled by the one instance that existed before the reload: nothing was
    // lost, and no second instance was created to take over.
    expect(new Set(received.map((r) => r.generation)).size).toBe(1);
  });

  it('rejects an invalid spec without touching the running pipeline', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('x')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    await Promise.all(handle.completions);

    const badSpec: TopologySpec = {
      sources: { in: { type: 'does_not_exist', options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const result = await pipeline.reload(badSpec);
    expect(result.ok).toBe(false);

    expect(pipeline.health().overall).toBe('running');
    expect(
      pipeline
        .snapshot()
        .components.map((c) => c.id)
        .sort(),
    ).toEqual(['in', 'out']);
    expect(collector.events.map((e) => (e as LogEvent).get('message'))).toEqual(['x']);
    await pipeline.stop();
  });

  it('rewires an unchanged producer to a newly added consumer', async () => {
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('first')] },
      { events: [LogEvent.fromMessage('second')], delayMs: 100 },
    ]);
    const { definition: original, collector: originalCollector } = createCollectingSinkDefinition({
      type: 'original_sink',
    });
    const registry = createRegistry(src, original);
    const specA: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: 'original_sink', options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(specA, { registry, clock });
    await pipeline.start();

    // Let the first (undelayed) step go out; the second is still waiting on its 100ms delay.
    while (handle.completions.length < 1) await Promise.resolve();
    await Promise.all(handle.completions);

    const { definition: newSink, collector: newCollector } = createCollectingSinkDefinition({
      type: 'new_sink',
    });
    registry.register(newSink);
    const specB: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        out: { type: 'original_sink', options: {}, inputs: ['in'] },
        extra: { type: 'new_sink', options: {}, inputs: ['in'] },
      },
    };
    const result = await pipeline.reload(specB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unchanged).toEqual(['in', 'out']);
      expect(result.added).toEqual(['extra']);
    }

    await clock.advance(100); // release the second scripted step, now that the reload is in effect
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    // The unchanged source's output now also reaches the newly added sink.
    expect(originalCollector.events.map((e) => (e as LogEvent).get('message'))).toEqual([
      'first',
      'second',
    ]);
    expect(newCollector.events.map((e) => (e as LogEvent).get('message'))).toEqual(['second']);
  });

  it('does not fail the upstream source when a send is blocked on a retiring inbox', async () => {
    // A ManualClock that is never advanced makes the deadline branch of drainAndStop
    // unreachable: if the fix regresses to closing the retiring inbox eagerly, this test fails
    // deterministically (not by timing out) because the source's second send is rejected with
    // ChannelClosedError before the gate is ever released.
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('first')] },
      { events: [LogEvent.fromMessage('second')] },
    ]);
    const { definition: snk, received, release } = gatedTaggedSinkDefinition('gated_snk_race');
    const registry = createRegistry(src, snk);
    // A one-event inbox: the first send fills it (nothing drains it while the sink's gate is
    // closed), so the second send blocks waiting for capacity.
    const specA: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        out: {
          type: 'gated_snk_race',
          options: { tag: 'a' },
          inputs: ['in'],
          buffer: { maxEvents: 1 },
        },
      },
    };
    const pipeline = await Pipeline.create(specA, { registry, clock });
    await pipeline.start();

    // Wait for the source to reach its second step: the first send has already been admitted
    // (completions[0] was pushed and its send resolved) and the second send's completions entry
    // has been pushed, which happens synchronously just before the second `ctx.output.send`
    // call — so once this observes two completions, that call has already reached the channel
    // and registered itself as a blocked pending send.
    while (handle.completions.length < 2) await Promise.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const specB: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        out: {
          type: 'gated_snk_race',
          options: { tag: 'b' },
          inputs: ['in'],
          buffer: { maxEvents: 1 },
        },
      },
    };
    const result = await pipeline.reload(specB);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toEqual(['out']);

    // The retiring sink is still running (just draining in the background); releasing its gate
    // lets it consume the buffered event and, in turn, admits the still-blocked second send.
    release();
    const statuses = await Promise.all(handle.completions);
    expect(statuses).toEqual(['delivered', 'delivered']);
    expect(received.map((r) => r.message).sort()).toEqual(['first', 'second']);

    const sourceHealth = pipeline.health().components.find((c) => c.id === 'in');
    expect(sourceHealth?.state).not.toBe('failed');
    expect(pipeline.health().overall).not.toBe('failed');

    await pipeline.stop();
  });
});
