import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK, EXIT_USAGE_ERROR } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

describe('ferrule list', () => {
  it('lists every group by default', async () => {
    const env = createFakeEnvironment({ argv: ['list'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('Sources');
    expect(env.stdoutText()).toContain('Transforms');
    expect(env.stdoutText()).toContain('Sinks');
    expect(env.stdoutText()).toContain('demo_logs');
    expect(env.stdoutText()).toContain('console');
  });

  it('restricts to one group', async () => {
    const env = createFakeEnvironment({ argv: ['list', 'sinks'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('Sinks');
    expect(env.stdoutText()).not.toContain('Sources');
  });

  it('rejects an unknown group with a suggestion', async () => {
    const env = createFakeEnvironment({ argv: ['list', 'sorcerers'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(env.stderrText()).toContain('unknown component group');
  });

  it('prints JSON', async () => {
    const env = createFakeEnvironment({ argv: ['list', 'sources', '--json'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(env.stdoutText()) as { source: { type: string }[] };
    expect(parsed.source.some((s) => s.type === 'demo_logs')).toBe(true);
  });
});

describe('ferrule describe', () => {
  it('describes a known component type with its options', async () => {
    const env = createFakeEnvironment({ argv: ['describe', 'demo_logs'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('demo_logs');
    expect(env.stdoutText()).toContain('eventsPerSecond');
  });

  it('prints JSON with the schema doc', async () => {
    const env = createFakeEnvironment({ argv: ['describe', 'console', '--json'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(env.stdoutText()) as { type: string; options: { type: string } }[];
    expect(parsed[0]?.type).toBe('console');
    expect(parsed[0]?.options.type).toBe('object');
  });

  it('rejects an unknown type with a suggestion', async () => {
    const env = createFakeEnvironment({ argv: ['describe', 'demo_log'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(env.stderrText()).toContain('demo_logs');
  });
});

describe('ferrule explain', () => {
  it('explains a script diagnostic code', async () => {
    const env = createFakeEnvironment({ argv: ['explain', 'E301'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('type mismatch');
  });

  it('explains a topology diagnostic code', async () => {
    const env = createFakeEnvironment({ argv: ['explain', 'E_CYCLE'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText().toLowerCase()).toContain('cycle');
  });

  it('rejects an unknown code', async () => {
    const env = createFakeEnvironment({ argv: ['explain', 'NOT_A_CODE'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it('lists every code with --list', async () => {
    const env = createFakeEnvironment({ argv: ['explain', '--list'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('E301');
    expect(env.stdoutText()).toContain('E_CYCLE');
  });
});
