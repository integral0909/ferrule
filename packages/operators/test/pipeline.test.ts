import { describe, expect, it } from 'vitest';
import { LogEvent, type Event } from '@ferrule/core';
import {
  ComponentRegistry,
  Pipeline,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  type TopologySpec,
} from '@ferrule/runtime';
import { remapFieldsTransform, sampleTransform, splitByKindTransform } from '@ferrule/operators';

function messages(events: readonly Event[]): string[] {
  return events.map((e) => (e as LogEvent).get('message') as string);
}

describe('operators wired into a real Pipeline', () => {
  it('remap_fields: a scripted source through the transform to a collecting sink', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.from({ message: 'hi', lvl: 'info' })] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = new ComponentRegistry();
    registry.register(src, snk, remapFieldsTransform);

    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        remap: {
          type: remapFieldsTransform.type,
          options: { operations: [{ op: 'rename', from: 'lvl', to: 'level' }] },
          inputs: ['in'],
        },
      },
      sinks: { out: { type: snk.type, options: {}, inputs: ['remap'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    await pipeline.stop();

    expect(status).toBe('delivered');
    expect(collector.events).toHaveLength(1);
    expect((collector.events[0] as LogEvent).get('level')).toBe('info');
    expect((collector.events[0] as LogEvent).has('lvl')).toBe(false);
  });

  it('sample: rate 0 drops every event, and the source still sees delivered', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = new ComponentRegistry();
    registry.register(src, snk, sampleTransform);

    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        s: { type: sampleTransform.type, options: { rate: 0 }, inputs: ['in'] },
      },
      sinks: { out: { type: snk.type, options: {}, inputs: ['s'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    await pipeline.stop();

    expect(status).toBe('delivered');
    expect(collector.events).toHaveLength(0);
  });

  it('split_by_kind: routes logs to one sink and drops nothing', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('x')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = new ComponentRegistry();
    registry.register(src, snk, splitByKindTransform);

    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        split: { type: splitByKindTransform.type, options: {}, inputs: ['in'] },
      },
      sinks: { out: { type: snk.type, options: {}, inputs: ['split.logs'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(messages(collector.events)).toEqual(['x']);
  });
});
