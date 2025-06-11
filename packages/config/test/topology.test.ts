import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import {
  loadConfig,
  toTopologySpec,
  topologyIssuesToDiagnostics,
  type LoadedConfig,
} from '@ferrule/config';
import {
  buildTopology,
  ComponentRegistry,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  Pipeline,
} from '@ferrule/runtime';

describe('config → topology', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ferrule-topology-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(yaml: string, registry: ComponentRegistry): Promise<LoadedConfig> {
    const file = path.join(dir, 'ferrule.yaml');
    await writeFile(file, yaml);
    return loadConfig(file, { registry, env: {} });
  }

  it('produces a spec the runtime can run end to end', async () => {
    const source = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('one'), LogEvent.fromMessage('two')] },
    ]);
    const sink = createCollectingSinkDefinition();
    const registry = new ComponentRegistry().register(source.definition, sink.definition);
    const config = await load(
      [
        'acknowledgements: true',
        'healthchecks:',
        '  enabled: false',
        'sources:',
        '  input:',
        '    type: test_script',
        'sinks:',
        '  out:',
        '    type: test_collect',
        '    inputs: input',
        '    buffer:',
        '      type: memory',
        '      max_events: 10',
      ].join('\n'),
      registry,
    );

    const spec = toTopologySpec(config);
    expect(spec.sinks['out']).toEqual({
      type: 'test_collect',
      options: {},
      inputs: ['input'],
      buffer: { kind: 'memory', maxEvents: 10 },
    });
    expect(spec.settings).toMatchObject({ acknowledgements: true, healthchecksEnabled: false });

    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await expect(source.handle.completions[0]).resolves.toBe('delivered');
    await pipeline.stop();
    expect(sink.collector.events.map((e) => (e as LogEvent).get('message'))).toEqual([
      'one',
      'two',
    ]);
  });

  it('formats port references and disk buffers, and applies overrides', async () => {
    const source = createScriptedSourceDefinition([]);
    const sink = createCollectingSinkDefinition();
    const registry = new ComponentRegistry().register(source.definition, sink.definition);
    const config = await load(
      [
        'data_dir: /from/config',
        'sources:',
        '  input:',
        '    type: test_script',
        'sinks:',
        '  out:',
        '    type: test_collect',
        '    inputs: [input.errors]',
        '    buffer:',
        '      type: disk',
        '      max_size: 1MiB',
        '      when_full: drop_newest',
      ].join('\n'),
      registry,
    );
    const spec = toTopologySpec(config, {
      dataDir: '/override',
      disableHealthchecks: true,
      shutdownDeadlineMs: 1000,
      continueOnComponentFailure: true,
    });
    expect(spec.sinks['out']).toMatchObject({
      inputs: ['input.errors'],
      buffer: { kind: 'disk', whenFull: 'drop_newest', disk: { maxBufferBytes: 1024 * 1024 } },
    });
    expect(spec.settings).toMatchObject({
      dataDir: '/override',
      healthchecksEnabled: false,
      shutdownDeadlineMs: 1000,
      continueOnComponentFailure: true,
    });
  });

  it('maps topology errors back to the component that caused them', async () => {
    const source = createScriptedSourceDefinition([]);
    const sink = createCollectingSinkDefinition();
    const registry = new ComponentRegistry().register(source.definition, sink.definition);
    const config = await load(
      [
        'sources:',
        '  input:',
        '    type: test_script',
        'sinks:',
        '  out:',
        '    type: test_collect',
        '    inputs: [inptu]',
      ].join('\n'),
      registry,
    );
    const result = await buildTopology(toTopologySpec(config), registry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const diagnostics = topologyIssuesToDiagnostics(result.errors, config);
    const unknownInput = diagnostics.find((d) => d.code === 'E_UNKNOWN_INPUT');
    expect(unknownInput?.message).toMatch(/^out: .*inptu/);
    expect(unknownInput?.file).toBe(path.join(dir, 'ferrule.yaml'));
    // Points at the body of the `out` component (1-based line 6).
    expect(unknownInput?.range?.start.line).toBe(6);
  });
});
