import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_OK, EXIT_USAGE_ERROR } from '../src/exit-codes.js';
import { createFakeEnvironment } from './support/environment.js';

describe('runCli', () => {
  it('prints top-level help with no arguments', async () => {
    const env = createFakeEnvironment({ argv: [] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('Usage: ferrule <command>');
    expect(env.stdoutText()).toContain('validate');
  });

  it('prints top-level help for --help', async () => {
    const env = createFakeEnvironment({ argv: ['--help'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('Commands:');
  });

  it('prints the version for --version', async () => {
    const env = createFakeEnvironment({ argv: ['--version'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText().trim()).toBe('0.0.0-test');
  });

  it('reports an unknown command with a suggestion', async () => {
    const env = createFakeEnvironment({ argv: ['validat'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(env.stderrText()).toContain('unknown command');
    expect(env.stderrText()).toContain('validate');
  });

  it('prints per-command help for --help after a command name', async () => {
    const env = createFakeEnvironment({ argv: ['list', '--help'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_OK);
    expect(env.stdoutText()).toContain('Usage: ferrule list');
  });

  it('reports a usage error for a bad flag on a real command', async () => {
    const env = createFakeEnvironment({ argv: ['list', '--nope'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(env.stderrText()).toContain('unknown flag');
  });

  it('never throws for a malformed argv', async () => {
    const env = createFakeEnvironment({ argv: ['describe'] });
    const code = await runCli(env);
    expect(code).toBe(EXIT_USAGE_ERROR);
  });
});
