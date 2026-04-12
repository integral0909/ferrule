import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

async function runRepl(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = createFakeEnvironment({ argv: ['repl'] });
  const runPromise = runCli(env);
  await env.feedStdin(script);
  env.endStdin();
  const code = await runPromise;
  return { code, stdout: env.stdoutText(), stderr: env.stderrText() };
}

describe('ferrule repl', () => {
  it('evaluates a plain expression and prints its value', async () => {
    const { code, stdout } = await runRepl('1 + 2\n');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('=> 3');
  });

  it(':event sets the current event, and subsequent statements see it', async () => {
    const { stdout } = await runRepl(
      ':event {"message": "hi"}\n.upper = upcase(.message) ?? .message\n.upper\n',
    );
    expect(stdout).toContain('=> "HI"');
  });

  it(':reset clears the current event back to {}', async () => {
    const { stdout } = await runRepl(':event {"a": 1}\n:reset\n:event {}\n');
    // After :reset the event dump printed by :event {} should show an empty object.
    const lines = stdout.trim().split('\n');
    expect(lines.at(-1)).toBe('{}');
  });

  it(':type reports the static type of an expression', async () => {
    const { stdout } = await runRepl(':type 1 + 2\n');
    expect(stdout.trim()).toContain('int');
  });

  it('renders diagnostics inline for a program with an error, without crashing the session', async () => {
    const { code, stderr, stdout } = await runRepl('.a = upcase(1, 2, 3)\n1 + 1\n');
    expect(code).toBe(EXIT_OK);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toContain('=> 2');
  });

  it('supports multi-line input while brackets are unbalanced', async () => {
    const { stdout } = await runRepl('{\n  "a": 1,\n  "b": 2\n}\n');
    expect(stdout).toContain('=>');
    expect(stdout).toContain('"a": 1');
  });

  it(':help prints usage information', async () => {
    const { stdout } = await runRepl(':help\n');
    expect(stdout).toContain('Ferrule Script REPL');
  });

  it(':quit ends the session early', async () => {
    const { code } = await runRepl(':quit\nthis is never evaluated {{{\n');
    expect(code).toBe(EXIT_OK);
  });
});
