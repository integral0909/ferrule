import { describe, expect, it } from 'vitest';
import { LogEvent, type Event } from '@ferrule/core';
import {
  ComponentRegistry,
  Pipeline,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  type TopologySpec,
} from '@ferrule/runtime';
import {
  filterTransform,
  remapFieldsTransform,
  routeTransform,
  sampleTransform,
  scriptTransform,
  splitByKindTransform,
} from '@ferrule/operators';

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

  it('script: compiles once at build time and transforms every event through a real pipeline', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.from({ level: 'info' }), LogEvent.from({ level: 'debug' })] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = new ComponentRegistry();
    registry.register(src, snk, scriptTransform);

    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        shape: {
          type: scriptTransform.type,
          options: { source: 'if .level == "debug" { drop }\n.level = upcase(.level) ?? "?"' },
          inputs: ['in'],
        },
      },
      sinks: { out: { type: snk.type, options: {}, inputs: ['shape'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    await pipeline.stop();

    expect(status).toBe('delivered');
    expect(collector.events).toHaveLength(1);
    expect((collector.events[0] as LogEvent).get('level')).toBe('INFO');
  });

  it('filter: keeps only matching events end to end', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.from({ status: 200 }), LogEvent.from({ status: 500 })] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = new ComponentRegistry();
    registry.register(src, snk, filterTransform);

    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        f: { type: filterTransform.type, options: { condition: '.status < 400' }, inputs: ['in'] },
      },
      sinks: { out: { type: snk.type, options: {}, inputs: ['f'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    await pipeline.stop();

    expect(status).toBe('delivered');
    expect(collector.events).toHaveLength(1);
    expect((collector.events[0] as LogEvent).get('status')).toBe(200n);
  });

  it('route: fans events out to per-route sinks', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.from({ status: 500 }), LogEvent.from({ status: 200 })] },
    ]);
    const { definition: errSink, collector: errCollector } = createCollectingSinkDefinition();
    const { definition: okSink, collector: okCollector } = createCollectingSinkDefinition({
      type: 'test_collect_ok',
    });
    const registry = new ComponentRegistry();
    registry.register(src, errSink, okSink, routeTransform);

    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        r: {
          type: routeTransform.type,
          options: {
            routes: [{ name: 'errors', condition: '.status >= 500' }],
            unmatched_port: 'ok',
          },
          inputs: ['in'],
        },
      },
      sinks: {
        err_out: { type: errSink.type, options: {}, inputs: ['r.errors'] },
        ok_out: { type: okSink.type, options: {}, inputs: ['r.ok'] },
      },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    await pipeline.stop();

    expect(status).toBe('delivered');
    expect((errCollector.events[0] as LogEvent).get('status')).toBe(500n);
    expect((okCollector.events[0] as LogEvent).get('status')).toBe(200n);
  });
});
