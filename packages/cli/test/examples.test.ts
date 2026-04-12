import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_OK } from '../src/exit-codes.js';
import { createFakeEnvironment } from './support/environment.js';

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

describe('packages/cli/examples', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ferrule-cli-examples-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('the examples directory is non-empty and has between 4 and 6 configs', async () => {
    const files = (await readdir(examplesDir)).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
    );
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeLessThanOrEqual(6);
  });

  it.each([
    'demo_to_console.yaml',
    'nginx_to_clickhouse.yaml',
    'otlp_traces_tail_sampling.yaml',
    'statsd_to_prometheus.yaml',
    'file_redact_to_loki.yaml',
    'route_by_severity.yaml',
  ])('%s validates cleanly', async (name) => {
    const path = join(examplesDir, name);
    const env = createFakeEnvironment({ argv: ['validate', '-c', path, '--data-dir', dataDir] });
    const code = await runCli(env);
    expect(env.stderrText()).toBe('');
    expect(code).toBe(EXIT_OK);
  });

  it('every file actually present in examples/ is covered by the list above', async () => {
    const files = (await readdir(examplesDir)).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
    );
    const covered = [
      'demo_to_console.yaml',
      'nginx_to_clickhouse.yaml',
      'otlp_traces_tail_sampling.yaml',
      'statsd_to_prometheus.yaml',
      'file_redact_to_loki.yaml',
      'route_by_severity.yaml',
    ];
    for (const file of files) expect(covered).toContain(file);
  });
});
