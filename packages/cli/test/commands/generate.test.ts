import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK, EXIT_USAGE_ERROR } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

describe('ferrule generate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-generate-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('scaffolds a source/sink chain given as a single slash-joined argument', async () => {
    const env = createFakeEnvironment({ argv: ['generate', 'demo_logs/console'], cwd: dir });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('sources:');
    expect(env.stdoutText()).toContain('demo_logs:');
    expect(env.stdoutText()).toContain('console:');
  });

  it('accepts space-separated arguments with a transform in the middle', async () => {
    const env = createFakeEnvironment({
      argv: ['generate', 'demo_logs', 'sample', 'console'],
      cwd: dir,
    });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('transforms:');
    expect(env.stdoutText()).toContain('sample:');
  });

  it('rejects an unknown component type', async () => {
    const env = createFakeEnvironment({ argv: ['generate', 'not_a_source/console'], cwd: dir });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(env.stderrText()).toContain('unknown source type');
  });

  it('writes to a file with --output, and the result passes ferrule validate', async () => {
    const outPath = join(dir, 'generated.yaml');
    const genEnv = createFakeEnvironment({
      argv: ['generate', 'demo_logs/console', '--output', outPath],
      cwd: dir,
    });
    const genCode = await runCli(genEnv);
    expect(genCode).toBe(EXIT_OK);

    const text = await readFile(outPath, 'utf8');
    expect(text).toContain('demo_logs');

    const validateEnv = createFakeEnvironment({ argv: ['validate', '-c', outPath], cwd: dir });
    const validateCode = await runCli(validateEnv);
    expect(validateEnv.stderrText()).toBe('');
    expect(validateCode).toBe(EXIT_OK);
  });

  it('generates a chain including a stateful sink (clickhouse) that still validates', async () => {
    const outPath = join(dir, 'ch.yaml');
    const genEnv = createFakeEnvironment({
      argv: ['generate', 'demo_logs/clickhouse', '--output', outPath],
      cwd: dir,
    });
    expect(await runCli(genEnv)).toBe(EXIT_OK);

    const validateEnv = createFakeEnvironment({
      argv: ['validate', '-c', outPath, '--no-environment'],
      cwd: dir,
    });
    const code = await runCli(validateEnv);
    expect(validateEnv.stderrText()).toBe('');
    expect(code).toBe(EXIT_OK);
  });
});
