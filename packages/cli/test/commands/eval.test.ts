import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_CONFIG_ERROR, EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

describe('ferrule eval', () => {
  it('runs a program over NDJSON stdin and writes NDJSON to stdout', async () => {
    const env = createFakeEnvironment({
      argv: ['eval', '-e', '.upper = upcase(.message) ?? .message'],
    });
    const runPromise = runCli(env);
    await env.feedStdin('{"message":"hi"}\n{"message":"there"}\n');
    env.endStdin();
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
    const lines = env.stdoutText().trim().split('\n');
    expect(JSON.parse(lines[0]!)).toEqual({ message: 'hi', upper: 'HI' });
    expect(JSON.parse(lines[1]!)).toEqual({ message: 'there', upper: 'THERE' });
  });

  it('drops events dropped by the program', async () => {
    const env = createFakeEnvironment({
      argv: ['eval', '-e', 'if .message == "skip" { drop }\n.seen = true'],
    });
    const runPromise = runCli(env);
    await env.feedStdin('{"message":"skip"}\n{"message":"keep"}\n');
    env.endStdin();
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
    const lines = env.stdoutText().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ message: 'keep', seen: true });
  });

  it('reports a compile error and exits 3', async () => {
    const env = createFakeEnvironment({ argv: ['eval', '-e', '.a = upcase('] });
    const runPromise = runCli(env);
    env.endStdin();
    const code = await runPromise;
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(env.stderrText().length).toBeGreaterThan(0);
  });

  it('skips invalid JSON lines with a warning instead of crashing', async () => {
    const env = createFakeEnvironment({ argv: ['eval', '-e', 'del(.x)'] });
    const runPromise = runCli(env);
    await env.feedStdin('not json\n{"a":1}\n');
    env.endStdin();
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
    expect(env.stderrText()).toContain('skipping invalid input line');
    expect(env.stdoutText().trim()).toBe('{"a":1}');
  });
});
