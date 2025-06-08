import { describe, expect, it } from 'vitest';
import { s } from '@ferrule/schema';
import { LogEvent } from '@ferrule/core';
import {
  Pipeline,
  createCollectingSinkDefinition,
  createMemoryEventBuffer,
  createScriptedSourceDefinition,
  defineSink,
  defineTransform,
  type EventBufferFactory,
  type EventBufferFactoryContext,
  type TopologySpec,
} from '@ferrule/runtime';
import { createRegistry } from './fixtures.js';

describe('Pipeline disk buffer factory hook', () => {
  it('builds a sink-configured disk buffer through bufferFactory and routes events through it', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const factoryCalls: EventBufferFactoryContext[] = [];
    const seenOptions: unknown[] = [];
    const bufferFactory: EventBufferFactory = (options, ctx) => {
      factoryCalls.push(ctx);
      seenOptions.push(options);
      return createMemoryEventBuffer(`disk-${ctx.componentId}`, { events: 100 });
    };
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        out: {
          type: snk.type,
          options: {},
          inputs: ['in'],
          buffer: { kind: 'disk', disk: { path: '/var/lib/ferrule/out' } },
        },
      },
    };
    const pipeline = await Pipeline.create(spec, { registry, bufferFactory });
    await pipeline.start();
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.componentId).toBe('out');
    expect(seenOptions[0]).toEqual({ path: '/var/lib/ferrule/out' });
    expect(collector.events.map((e) => (e as LogEvent).get('message'))).toEqual(['a']);
  });

  it('fails to start when a sink requests a disk buffer but no bufferFactory is configured', async () => {
    const { definition: src } = createScriptedSourceDefinition([]);
    const { definition: snk } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'], buffer: { kind: 'disk' } } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await expect(pipeline.start()).rejects.toThrow(/bufferFactory/);
  });
});

describe('Pipeline sink buffer whenFull: drop_newest', () => {
  it('finalizes dropped events as errored instead of leaving their acknowledgement hanging', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedSink = defineSink({
      kind: 'sink',
      type: 'gated_drop',
      description: 'never drains until released',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        run: async (ctx) => {
          await gate;
          for await (const batch of ctx.input) {
            for (const event of batch) event.metadata.finalizers.finish('delivered');
          }
        },
      }),
    });
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
      { events: [LogEvent.fromMessage('b')] },
    ]);
    const registry = createRegistry(src, gatedSink);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        out: {
          type: 'gated_drop',
          options: {},
          inputs: ['in'],
          buffer: { kind: 'memory', maxEvents: 1, whenFull: 'drop_newest' },
        },
      },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent; // 'a' fills the 1-event buffer; 'b' arrives while it's still full

    release();
    const statuses = await Promise.all(handle.completions);
    expect(statuses).toEqual(['delivered', 'errored']);
    await pipeline.stop();
  });
});

describe('Pipeline undeclared-port contract enforcement', () => {
  it('fails the component and finalizes the event as errored when it pushes to an undeclared port', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const badPort = defineTransform({
      kind: 'transform',
      type: 'bad_port',
      description: 'pushes to a port it never declared',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        process: (events, out) => {
          for (const event of events) out.push(event, 'nope');
        },
      }),
    });
    const { definition: snk } = createCollectingSinkDefinition();
    const registry = createRegistry(src, badPort, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: badPort.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('errored');
    await pipeline.stop();

    expect(pipeline.health().components.find((c) => c.id === 't')?.state).toBe('failed');
  });
});
