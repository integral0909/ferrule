import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemClock } from '@ferrule/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

describe('ferrule bench', () => {
  it('reports throughput and latency percentiles for a short run', async () => {
    const env = createFakeEnvironment({
      argv: ['bench', '--duration', '300ms', '--events-per-second', '500'],
      clock: new SystemClock(),
    });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const out = env.stdoutText();
    expect(out).toContain('events:');
    expect(out).toContain('throughput:');
    expect(out).toContain('latency p50:');
    expect(out).toContain('latency p90:');
    expect(out).toContain('latency p99:');
    const events = Number(/events:\s*(\d+)/.exec(out)?.[1] ?? '0');
    expect(events).toBeGreaterThan(0);
  }, 10000);

  describe('--script', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-bench-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('inserts a script transform between the source and the blackhole sink', async () => {
      const file = join(dir, 'redact.fe');
      await writeFile(file, 'del(.message)\n', 'utf8');
      const env = createFakeEnvironment({
        argv: ['bench', '--duration', '200ms', '--events-per-second', '200', '--script', file],
        cwd: dir,
        clock: new SystemClock(),
      });
      const code = await runCli(env);
      expect(code).toBe(EXIT_OK);
      expect(env.stdoutText()).toContain('events:');
    }, 10000);
  });
});
