import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_CONFIG_ERROR, EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

describe('ferrule validate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-validate-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, contents, 'utf8');
    return file;
  }

  it('exits 0 and prints a summary for a valid pipeline', async () => {
    const file = await write(
      'ok.yaml',
      'sources:\n  demo:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = createFakeEnvironment({ argv: ['validate', '-c', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('valid:');
    expect(env.stdoutText()).toContain('0 error(s)');
  });

  it('exits 3 and renders a code frame for a YAML/schema error', async () => {
    const file = await write(
      'bad.yaml',
      'sources:\n  demo:\n    type: not_a_real_source\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = createFakeEnvironment({ argv: ['validate', '-c', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(env.stderrText()).toContain('unknown source type');
    expect(env.stderrText()).toContain('bad.yaml');
  });

  it('exits 3 for a topology error (unknown input) with a rendered diagnostic', async () => {
    const file = await write(
      'cycle.yaml',
      'sources:\n  demo:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [nope]\n',
    );
    const env = createFakeEnvironment({ argv: ['validate', '-c', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(env.stderrText()).toContain('unknown input');
  });

  it('reports warnings (e.g. an unused source) without failing', async () => {
    const file = await write(
      'unused.yaml',
      'sources:\n  demo:\n    type: demo_logs\n  spare:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = createFakeEnvironment({ argv: ['validate', '-c', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('1 warning');
  });

  it('supports --json output', async () => {
    const file = await write(
      'ok2.yaml',
      'sources:\n  demo:\n    type: demo_logs\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n',
    );
    const env = createFakeEnvironment({ argv: ['validate', '-c', file, '--json'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(env.stdoutText()) as { ok: boolean; components: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.components).toContain('demo');
  });

  it('validates a directory of config files', async () => {
    await write('sources.yaml', 'sources:\n  demo:\n    type: demo_logs\n');
    await write('sinks.yaml', 'sinks:\n  out:\n    type: console\n    inputs: [demo]\n');
    const env = createFakeEnvironment({ argv: ['validate', '-c', dir] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
  });

  it('requires -c/--config', async () => {
    const env = createFakeEnvironment({ argv: ['validate'] });
    const code = await runCli(env);
    expect(code).toBe(2);
    expect(env.stderrText()).toContain('config');
  });
});
