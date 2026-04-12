import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_TESTS_FAILED } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

const PIPELINE_CONFIG = [
  'sources:',
  '  in:',
  '    type: demo_logs',
  'transforms:',
  '  shape:',
  '    type: script',
  '    inputs: [in]',
  '    source: |',
  '      .upper = upcase(.message) ?? .message',
  '',
  '      test "uppercases the message" {',
  '        given { message: "hi" }',
  '        expect { upper: "HI" }',
  '      }',
  'sinks:',
  '  out:',
  '    type: console',
  '    inputs: [shape]',
  '',
].join('\n');

describe('ferrule test', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-test-'));
    await writeFile(join(dir, 'app.yaml'), PIPELINE_CONFIG, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, contents, 'utf8');
    return file;
  }

  it('runs pipeline cases and the config-referenced inline script tests together, all passing', async () => {
    const file = await write(
      'app.test.yaml',
      [
        'config: ./app.yaml',
        'cases:',
        '  - name: passes an event through to the sink',
        '    inputs:',
        '      in:',
        '        - { message: "hi" }',
        '    outputs:',
        '      out:',
        '        count: 1',
        '        events:',
        '          - { message: "hi", upper: "HI" }',
        '',
      ].join('\n'),
    );
    const env = createFakeEnvironment({ argv: ['test', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('passes an event through to the sink');
    expect(env.stdoutText()).toContain('uppercases the message');
    expect(env.stdoutText()).toMatch(/2\/2 passed/);
  });

  it('reports a failing pipeline case with exit 4', async () => {
    const file = await write(
      'fail.test.yaml',
      [
        'config: ./app.yaml',
        'cases:',
        '  - name: wrong expectation',
        '    inputs:',
        '      in:',
        '        - { message: "hi" }',
        '    outputs:',
        '      out:',
        '        none: true',
        '',
      ].join('\n'),
    );
    const env = createFakeEnvironment({ argv: ['test', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_TESTS_FAILED);
    expect(env.stdoutText()).toContain('failed');
  });

  it('exits 3 for a malformed test file, rendered as a code frame', async () => {
    const file = await write('broken.test.yaml', 'config: ./app.yaml\ncases: []\n');
    const env = createFakeEnvironment({ argv: ['test', file] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(env.stderrText()).toContain('must not be empty');
  });

  it('supports the junit reporter', async () => {
    const file = await write(
      'j.test.yaml',
      [
        'config: ./app.yaml',
        'cases:',
        '  - name: ok',
        '    inputs:',
        '      in: []',
        '    outputs:',
        '      out:',
        '        none: true',
        '',
      ].join('\n'),
    );
    const env = createFakeEnvironment({ argv: ['test', file, '--reporter', 'junit'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('<testsuites');
    expect(env.stdoutText()).toContain('name="ok"');
  });

  it('supports the json reporter and --output', async () => {
    const file = await write(
      'j2.test.yaml',
      [
        'config: ./app.yaml',
        'cases:',
        '  - name: ok',
        '    inputs:',
        '      in: []',
        '    outputs:',
        '      out:',
        '        none: true',
        '',
      ].join('\n'),
    );
    const outPath = join(dir, 'report.json');
    const env = createFakeEnvironment({
      argv: ['test', file, '--reporter', 'json', '--output', outPath],
      cwd: dir,
    });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(outPath, 'utf8')) as { total: number; passed: number };
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.passed).toBe(parsed.total);
  });

  it('discovers test files under a directory', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true });
    await write(
      'nested/one.test.yaml',
      [
        'config: ../app.yaml',
        'cases:',
        '  - name: ok',
        '    inputs:',
        '      in: []',
        '    outputs:',
        '      out:',
        '        none: true',
        '',
      ].join('\n'),
    );
    const env = createFakeEnvironment({ argv: ['test', dir] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
  });

  it('reports no test files found when nothing matches', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ferrule-cli-test-empty-'));
    try {
      const env = createFakeEnvironment({ argv: ['test', empty] });
      const code = await runCli(env);
      expect(code).toBe(EXIT_CONFIG_ERROR);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
