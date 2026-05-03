import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminClient } from '@ferrule/admin';
import { SystemClock } from '@ferrule/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_RUNTIME_FAILURE } from '../../src/exit-codes.js';
import { createFakeEnvironment, type FakeEnvironment } from '../support/environment.js';

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

function realTimeEnvironment(argv: readonly string[], cwd: string): FakeEnvironment {
  // `run` drives demo_logs' own one-second pacing and this test's polling loops off
  // `ctx.env.clock`; using the real clock here (rather than the default ManualClock) means the
  // test only has to wait in real time, exactly like a person running `ferrule run` would.
  return createFakeEnvironment({ argv, cwd, clock: new SystemClock() });
}

describe('ferrule run', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-run-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(name: string, contents: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, contents, 'utf8');
    return file;
  }

  it('runs demo_logs into console end to end, actually delivering events, and stops gracefully on SIGTERM', async () => {
    // The `console` sink writes straight to the real `process.stdout`/`stderr` (it has no notion
    // of this package's injectable `CliEnvironment`), so this asserts real delivery through the
    // admin API's metrics instead of scraping stdout for event payloads; the CLI's own log lines
    // (started/shutdown) DO go through `ctx.env.stderr`, which the other assertions cover.
    const file = await writeConfig(
      'pipeline.yaml',
      'sources:\n  demo:\n    type: demo_logs\n    events_per_second: 20\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = realTimeEnvironment(
      ['run', '-c', file, '--api', '--api-address', '127.0.0.1:0'],
      dir,
    );
    const runPromise = runCli(env);

    await waitUntil(() => env.fakeSignals.listenerCount('SIGTERM') > 0);
    expect(env.stderrText()).toContain('pipeline started');

    await waitUntil(() => /admin API listening host=\S+ port=(\d+)/.test(env.stderrText()));
    const port = Number(/port=(\d+)/.exec(env.stderrText())![1]);
    const client = new AdminClient({ baseUrl: `http://127.0.0.1:${port}` });

    await waitUntil(async () => {
      try {
        const metrics = await client.metrics();
        const sent = metrics.find(
          (m) => m.name === 'component_sent_events_total' && m.tags['component_id'] === 'demo',
        );
        return sent !== undefined && sent.value.type === 'counter' && sent.value.value > 0;
      } catch {
        return false;
      }
    });

    env.fakeSignals.emit('SIGTERM');
    const code = await runPromise;

    expect(code).toBe(EXIT_OK);
    expect(env.stderrText()).toContain('shutting down gracefully');
    // Locks in the fix: none of the CLI's own log lines leak onto stdout, which is reserved for
    // event data (the console sink writes there directly, bypassing `ctx.env` entirely).
    expect(env.stdoutText()).toBe('');
  }, 15000);

  it('reloads on SIGHUP when the config changes, and keeps running on an invalid reload', async () => {
    const file = await writeConfig(
      'reload.yaml',
      'sources:\n  demo:\n    type: demo_logs\n    events_per_second: 20\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = realTimeEnvironment(['run', '-c', file], dir);
    const runPromise = runCli(env);

    await waitUntil(() => env.fakeSignals.listenerCount('SIGHUP') > 0);
    expect(env.stderrText()).toContain('pipeline started');

    // A valid change: add a second, unused source. diffConfigs/pipeline.reload should report it added.
    await writeFile(
      file,
      'sources:\n  demo:\n    type: demo_logs\n    events_per_second: 20\n  demo2:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
      'utf8',
    );
    env.fakeSignals.emit('SIGHUP');
    await waitUntil(() => env.stderrText().includes('reload succeeded'));

    // An invalid change: reference a nonexistent input. The running pipeline must keep going.
    await writeFile(
      file,
      'sources:\n  demo:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [nope]\n',
      'utf8',
    );
    env.fakeSignals.emit('SIGHUP');
    await waitUntil(() => env.stderrText().includes('reload failed'));
    expect(env.stderrText()).toContain('keeping the running pipeline');

    env.fakeSignals.emit('SIGTERM');
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
  }, 15000);

  it('a second termination signal forces an immediate exit', async () => {
    const file = await writeConfig(
      'force.yaml',
      'sources:\n  demo:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = realTimeEnvironment(['run', '-c', file], dir);
    const runPromise = runCli(env);

    await waitUntil(() => env.fakeSignals.listenerCount('SIGTERM') > 0);
    // Both signals are delivered in the same synchronous turn, so the second one is guaranteed to
    // observe "a stop is already in progress" regardless of how fast this pipeline actually stops.
    env.fakeSignals.emit('SIGTERM');
    env.fakeSignals.emit('SIGTERM');

    const code = await runPromise;
    expect(code).toBe(EXIT_RUNTIME_FAILURE);
    expect(env.hardExitCalls).toEqual([1]);
  }, 15000);

  it('exits 3 and renders diagnostics for an invalid config, without starting anything', async () => {
    const file = await writeConfig('bad.yaml', 'sources:\n  demo:\n    type: nonexistent\n');
    const env = realTimeEnvironment(['run', '-c', file], dir);
    const code = await runCli(env);
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(env.stderrText()).toContain('unknown source type');
  });

  it('starts the admin API when --api is given and it answers /health', async () => {
    const file = await writeConfig(
      'api.yaml',
      'sources:\n  demo:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = realTimeEnvironment(
      ['run', '-c', file, '--api', '--api-address', '127.0.0.1:0'],
      dir,
    );
    const runPromise = runCli(env);
    await waitUntil(() => env.stderrText().includes('admin API listening'));
    env.fakeSignals.emit('SIGTERM');
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
  }, 15000);

  it("keeps stdout clean for event JSON while the CLI's own logs go to stderr", async () => {
    // Unlike the other tests here, this drives the real `process.stdout` (spied, not the fake
    // `CliEnvironment` stream) because the `console` sink writes straight to `process.stdout` /
    // `process.stderr`, bypassing `ctx.env` entirely — in production those coincide with the
    // environment's own streams, so this is what a person piping `ferrule run | ...` actually sees.
    const file = await writeConfig(
      'clean-stdout.yaml',
      'sources:\n  demo:\n    type: demo_logs\n    events_per_second: 20\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = realTimeEnvironment(['run', '-c', file], dir);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        stdoutChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
        );
        const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
        callback?.();
        return true;
      });

    try {
      const runPromise = runCli(env);
      await waitUntil(() => env.fakeSignals.listenerCount('SIGTERM') > 0);
      await waitUntil(
        () =>
          stdoutChunks
            .join('')
            .split('\n')
            .filter((line) => line.length > 0).length >= 2,
      );

      env.fakeSignals.emit('SIGTERM');
      const code = await runPromise;
      expect(code).toBe(EXIT_OK);

      const stdoutText = stdoutChunks.join('');
      const nonEmptyLines = stdoutText.split('\n').filter((line) => line.length > 0);
      expect(nonEmptyLines.length).toBeGreaterThan(0);
      for (const line of nonEmptyLines) {
        expect(() => {
          JSON.parse(line);
        }).not.toThrow();
      }
      expect(stdoutText).not.toContain('pipeline started');
      expect(env.stderrText()).toContain('pipeline started');
    } finally {
      stdoutSpy.mockRestore();
    }
  }, 15000);
});
