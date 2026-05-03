import { createAdminServer, type AdminServer } from '@ferrule/admin';
import {
  ComponentRegistry,
  MetricsRegistry,
  Pipeline,
  SystemClock,
  createNullLogger,
} from '@ferrule/runtime';
import { builtinSources } from '@ferrule/sources';
import { streamFamilySinks } from '@ferrule/sinks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ferrule tap / ferrule top (against a real running pipeline + admin server)', () => {
  let pipeline: Pipeline;
  let admin: AdminServer;
  let apiAddress: string;

  beforeEach(async () => {
    const registry = new ComponentRegistry().register(...builtinSources(), ...streamFamilySinks());
    const clock = new SystemClock();
    const metrics = new MetricsRegistry({ clock });
    pipeline = await Pipeline.create(
      {
        sources: { demo: { type: 'demo_logs', options: { events_per_second: 30 } } },
        sinks: { out: { type: 'blackhole', options: {}, inputs: ['demo'] } },
      },
      { registry, clock, metrics, logger: createNullLogger() },
    );
    await pipeline.start();
    admin = createAdminServer({ pipeline, metrics, address: { host: '127.0.0.1', port: 0 } });
    const bound = await admin.start();
    apiAddress = `${bound.host}:${bound.port}`;
  });

  afterEach(async () => {
    await admin.stop();
    await pipeline.stop();
  });

  it('tap streams NDJSON events from a component', async () => {
    const env = createFakeEnvironment({
      argv: ['tap', 'demo', '--api-address', apiAddress, '--format', 'ndjson', '--limit', '3'],
    });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const lines = env.stdoutText().trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { kind: string; fields: { message: string } };
      expect(parsed.kind).toBe('log');
    }
  });

  it('tap prints pretty (indented) JSON by default', async () => {
    const env = createFakeEnvironment({
      argv: ['tap', 'demo', '--api-address', apiAddress, '--limit', '1'],
    });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('\n  "kind"');
  });

  it('tap reports a clean error for an unknown api address', async () => {
    const env = createFakeEnvironment({
      argv: ['tap', 'demo', '--api-address', '127.0.0.1:1', '--limit', '1'],
    });
    const code = await runCli(env);
    expect(code).not.toBe(EXIT_OK);
  });

  it('top --once prints a snapshot table with every component', async () => {
    const env = createFakeEnvironment({ argv: ['top', '--api-address', apiAddress, '--once'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('overall: running');
    expect(env.stdoutText()).toContain('demo');
    expect(env.stdoutText()).toContain('out');
  });

  it('top with a real (system) clock refreshes and stops cleanly on SIGTERM', async () => {
    const env = createFakeEnvironment({
      argv: ['top', '--api-address', apiAddress, '--interval', '20ms'],
      clock: new SystemClock(),
    });
    const runPromise = runCli(env);
    await waitUntil(() => env.stdoutText().includes('overall: running'));
    // Let at least one more refresh happen so a rate can be computed from two samples.
    await new Promise((resolve) => setTimeout(resolve, 60));
    env.fakeSignals.emit('SIGTERM');
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText().split('overall: running').length).toBeGreaterThan(2);
  });
});
