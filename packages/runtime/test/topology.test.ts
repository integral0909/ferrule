import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FerruleError } from '@ferrule/core';
import { s } from '@ferrule/schema';
import {
  buildTopology,
  ComponentRegistry,
  defineSource,
  type TopologySpec,
} from '@ferrule/runtime';
import {
  basicSinkDefinition,
  basicSourceDefinition,
  basicTransformDefinition,
  createRegistry,
} from './fixtures.js';

function expectError(
  result: Awaited<ReturnType<typeof buildTopology>>,
): asserts result is Extract<Awaited<ReturnType<typeof buildTopology>>, { ok: false }> {
  expect(result.ok).toBe(false);
}

describe('buildTopology', () => {
  it('builds a valid minimal source -> sink pipeline', async () => {
    const registry = createRegistry(basicSourceDefinition('src'), basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in'] } },
    };
    const result = await buildTopology(spec, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.order).toEqual(['in', 'out']);
    expect(result.topology.components.size).toBe(2);
    expect(result.warnings).toHaveLength(0);
  });

  it('builds a source -> transform -> sink pipeline with the transform passing events through', async () => {
    const registry = createRegistry(
      basicSourceDefinition('src'),
      basicTransformDefinition('xform'),
      basicSinkDefinition('snk'),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      transforms: { shape: { type: 'xform', options: {}, inputs: ['in'] } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['shape'] } },
    };
    const result = await buildTopology(spec, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.order).toEqual(['in', 'shape', 'out']);
  });

  it('reports unknown component types with a did-you-mean suggestion', async () => {
    const registry = createRegistry(
      basicSourceDefinition('http_source'),
      basicSinkDefinition('snk'),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'htpp_source', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_UNKNOWN_COMPONENT_TYPE');
    expect(issue?.componentId).toBe('in');
    expect(issue?.message).toContain('http_source');
  });

  it('reports schema validation issues per field', async () => {
    const registry = createRegistry(
      defineSource({
        kind: 'source',
        type: 'needs_option',
        description: 'x',
        options: s.object({ address: s.string() }),
        produces: () => ['log'],
        build: () => ({ run: () => Promise.resolve() }),
      }),
      basicSinkDefinition('snk'),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'needs_option', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_SCHEMA');
    expect(issue?.componentId).toBe('in');
    expect(issue?.message).toContain('address');
  });

  it('reports unknown inputs with a did-you-mean suggestion', async () => {
    const registry = createRegistry(basicSourceDefinition('src'), basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: { app_logs: { type: 'src', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['app_log'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_UNKNOWN_INPUT');
    expect(issue?.message).toContain('app_log');
    expect(issue?.message).toContain('app_logs');
  });

  it('reports references to nonexistent ports', async () => {
    const registry = createRegistry(basicSourceDefinition('src'), basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in.nope'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_UNKNOWN_PORT');
    expect(issue?.message).toContain('nope');
  });

  it('accepts a reference to a declared named port', async () => {
    const registry = createRegistry(
      basicSourceDefinition('src', { outputs: [{ name: 'errors', description: 'bad records' }] }),
      basicSinkDefinition('snk'),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in.errors'] } },
    };
    const result = await buildTopology(spec, registry);
    expect(result.ok).toBe(true);
  });

  it('reports cycles with the full cycle path', async () => {
    const registry = createRegistry(basicTransformDefinition('xform'), basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: {},
      transforms: {
        a: { type: 'xform', options: {}, inputs: ['b'] },
        b: { type: 'xform', options: {}, inputs: ['a'] },
      },
      sinks: { out: { type: 'snk', options: {}, inputs: ['a'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_CYCLE');
    expect(issue?.message).toContain('a');
    expect(issue?.message).toContain('b');
  });

  it("rejects a sink used as another component's input", async () => {
    const registry = createRegistry(
      basicSourceDefinition('src'),
      basicSinkDefinition('snk'),
      basicTransformDefinition('xform'),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      transforms: { shape: { type: 'xform', options: {}, inputs: ['out'] } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    expect(result.errors.some((e) => e.code === 'E_SINK_AS_INPUT')).toBe(true);
  });

  it('rejects incompatible event kinds between a producer and a consumer', async () => {
    const registry = createRegistry(
      basicSourceDefinition('metric_src', { produces: ['metric'] }),
      basicSinkDefinition('log_sink', { accepts: ['log'] }),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'metric_src', options: {} } },
      sinks: { out: { type: 'log_sink', options: {}, inputs: ['in'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_EVENT_KIND_MISMATCH');
    expect(issue?.componentId).toBe('out');
  });

  it("propagates a transform's produced kinds to downstream mismatch checks", async () => {
    const registry = createRegistry(
      basicSourceDefinition('log_src', { produces: ['log'] }),
      basicTransformDefinition('to_metric', { produces: () => ['metric'] }),
      basicSinkDefinition('log_sink', { accepts: ['log'] }),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'log_src', options: {} } },
      transforms: { conv: { type: 'to_metric', options: {}, inputs: ['in'] } },
      sinks: { out: { type: 'log_sink', options: {}, inputs: ['conv'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    expect(
      result.errors.some((e) => e.code === 'E_EVENT_KIND_MISMATCH' && e.componentId === 'out'),
    ).toBe(true);
  });

  it('rejects transforms and sinks with no inputs', async () => {
    const registry = createRegistry(basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: {},
      sinks: { out: { type: 'snk', options: {}, inputs: [] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    expect(result.errors.some((e) => e.code === 'E_NO_INPUTS' && e.componentId === 'out')).toBe(
      true,
    );
  });

  it('warns about sources that are never used, without failing the build', async () => {
    const registry = createRegistry(basicSourceDefinition('src'), basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: { used: { type: 'src', options: {} }, unused: { type: 'src', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['used'] } },
    };
    const result = await buildTopology(spec, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.warnings.some((w) => w.code === 'W_UNUSED_SOURCE' && w.componentId === 'unused'),
    ).toBe(true);
  });

  it('rejects a component ID reused across categories', async () => {
    const registry = createRegistry(basicSourceDefinition('src'), basicSinkDefinition('snk'));
    const spec: TopologySpec = {
      sources: { dup: { type: 'src', options: {} } },
      sinks: { dup: { type: 'snk', options: {}, inputs: ['dup'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    expect(result.errors.some((e) => e.code === 'E_DUPLICATE_ID')).toBe(true);
  });

  it('collects a FerruleError thrown from build()', async () => {
    const registry = createRegistry(
      defineSource({
        kind: 'source',
        type: 'broken',
        description: 'x',
        options: s.object({}),
        produces: () => ['log'],
        build: () => {
          throw new FerruleError('E_BROKEN', 'refuses to build');
        },
      }),
      basicSinkDefinition('snk'),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'broken', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    const issue = result.errors.find((e) => e.code === 'E_BROKEN');
    expect(issue?.message).toContain('refuses to build');
  });

  it('collects every error in a single pass rather than stopping at the first', async () => {
    const registry = new ComponentRegistry();
    const spec: TopologySpec = {
      sources: { in: { type: 'nope', options: {} } },
      sinks: { out: { type: 'also_nope', options: {}, inputs: ['unknown_input'] } },
    };
    const result = await buildTopology(spec, registry);
    expectError(result);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('gives every component a reserved data directory when a root dataDir is configured', async () => {
    const registry = createRegistry(basicSourceDefinition('src'), basicSinkDefinition('snk'));
    const dataDir = await mkdtemp(join(tmpdir(), 'ferrule-topology-'));
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['in'] } },
      settings: { dataDir },
    };
    const result = await buildTopology(spec, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const component = result.topology.components.get('in');
    expect(component?.dataDir).toBe(join(dataDir, 'in'));
  });
});

describe('event kind defaults', () => {
  it('a transform with no produces() passes through its input kinds unchanged', async () => {
    const registry = createRegistry(
      basicSourceDefinition('src', { produces: ['span'] }),
      basicTransformDefinition('xform', { accepts: ['span'] }),
      basicSinkDefinition('snk', { accepts: ['span'] }),
    );
    const spec: TopologySpec = {
      sources: { in: { type: 'src', options: {} } },
      transforms: { t: { type: 'xform', options: {}, inputs: ['in'] } },
      sinks: { out: { type: 'snk', options: {}, inputs: ['t'] } },
    };
    const result = await buildTopology(spec, registry);
    expect(result.ok).toBe(true);
  });
});
