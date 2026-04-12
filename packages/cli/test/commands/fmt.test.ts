import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

describe('ferrule fmt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-fmt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('formats a file in place', async () => {
    const file = join(dir, 'a.fe');
    await writeFile(file, '.a=1\n', 'utf8');
    const env = createFakeEnvironment({ argv: ['fmt', file], cwd: dir });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const text = await readFile(file, 'utf8');
    expect(text).toBe('.a = 1\n');
  });

  it('leaves an already-formatted file untouched and reports nothing changed', async () => {
    const file = join(dir, 'b.fe');
    await writeFile(file, '.a = 1\n', 'utf8');
    const env = createFakeEnvironment({ argv: ['fmt', file], cwd: dir });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toBe('');
  });

  it('--check reports files that would change and exits 1 without writing', async () => {
    const file = join(dir, 'c.fe');
    await writeFile(file, '.a=1\n', 'utf8');
    const env = createFakeEnvironment({ argv: ['fmt', '--check', file], cwd: dir });
    const code = await runCli(env);
    expect(code).toBe(1);
    expect(env.stdoutText()).toContain('would reformat');
    const text = await readFile(file, 'utf8');
    expect(text).toBe('.a=1\n');
  });

  it('--check exits 0 when nothing needs to change', async () => {
    const file = join(dir, 'd.fe');
    await writeFile(file, '.a = 1\n', 'utf8');
    const env = createFakeEnvironment({ argv: ['fmt', '--check', file], cwd: dir });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
  });

  it('--stdin formats from stdin to stdout', async () => {
    const env = createFakeEnvironment({ argv: ['fmt', '--stdin'], cwd: dir });
    const runPromise = runCli(env);
    await env.feedStdin('.a=1\n');
    env.endStdin();
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toBe('.a = 1\n');
  });
});
