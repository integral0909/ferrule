import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogEvent, type Event } from '@ferrule/core';
import { InMemoryFileSystem } from '@ferrule/buffer';
import {
  ComponentRegistry,
  createCollectingSinkDefinition,
  createDiskBufferFactory,
  createNullLogger,
  createScriptedSourceDefinition,
  ManualClock,
  Pipeline,
  type TopologySpec,
} from '@ferrule/runtime';

const messages = (events: readonly Event[]) => events.map((e) => (e as LogEvent).get('message'));

function spec(dataDir: string | undefined): TopologySpec {
  return {
    sources: { input: { type: 'test_script', options: {} } },
    sinks: {
      out: {
        type: 'test_collect',
        options: {},
        inputs: ['input'],
        buffer: { kind: 'disk', disk: { maxBufferBytes: 1024 * 1024 } },
      },
    },
    settings: {
      ...(dataDir === undefined ? {} : { dataDir }),
      acknowledgements: true,
      healthchecksEnabled: false,
      shutdownDeadlineMs: 50,
    },
  };
}

describe('disk buffer factory', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ferrule-disk-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('delivers through a disk buffer and acknowledges the source once durable', async () => {
    const fs = new InMemoryFileSystem();
    const source = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')] },
    ]);
    const sink = createCollectingSinkDefinition();
    const registry = new ComponentRegistry().register(source.definition, sink.definition);
    const pipeline = await Pipeline.create(spec(dataDir), {
      registry,
      bufferFactory: createDiskBufferFactory({ fs }),
    });
    await pipeline.start();
    await expect(source.handle.completions[0]).resolves.toBe('delivered');
    await pipeline.stop();
    expect(messages(sink.collector.events)).toEqual(['a', 'b']);
  });

  it('redelivers events a sink never finished after the pipeline restarts', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new ManualClock();
    const source = createScriptedSourceDefinition([{ events: [LogEvent.fromMessage('pending')] }]);
    // First run: the sink holds events without finishing them (e.g. a destination outage).
    const stuck = createCollectingSinkDefinition({ finish: () => undefined });
    const registry1 = new ComponentRegistry().register(source.definition, stuck.definition);
    const first = await Pipeline.create(spec(dataDir), {
      registry: registry1,
      clock,
      logger: createNullLogger(),
      bufferFactory: createDiskBufferFactory({ fs }),
    });
    await first.start();
    // Durable in the buffer, so the source is acknowledged even though the sink is stuck.
    await expect(source.handle.completions[0]).resolves.toBe('delivered');
    const stopping = first.stop();
    await clock.advance(1_000);
    await stopping;

    const idle = createScriptedSourceDefinition([]);
    const healthy = createCollectingSinkDefinition();
    const registry2 = new ComponentRegistry().register(idle.definition, healthy.definition);
    const second = await Pipeline.create(spec(dataDir), {
      registry: registry2,
      bufferFactory: createDiskBufferFactory({ fs }),
    });
    await second.start();
    await waitFor(() => healthy.collector.events.length === 1);
    await second.stop();
    expect(messages(healthy.collector.events)).toEqual(['pending']);
  });

  it('requires a data directory', async () => {
    const source = createScriptedSourceDefinition([]);
    const sink = createCollectingSinkDefinition();
    const registry = new ComponentRegistry().register(source.definition, sink.definition);
    const pipeline = await Pipeline.create(spec(undefined), {
      registry,
      bufferFactory: createDiskBufferFactory({ fs: new InMemoryFileSystem() }),
    });
    await expect(pipeline.start()).rejects.toThrow(/requires data_dir/);
  });
});

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}
