/**
 * `ferrule validate --no-environment -c <example>` must pass for every example in
 * `packages/cli/examples/`, using the *built* binary (`packages/cli/dist/bin.js`) — the closest
 * thing to what a real user actually runs, and a check that the compiled `dist` output (not just
 * the TS source `examples.test.ts` exercises in-process) is itself correct. Falls back to
 * running the command in-process (like `examples.test.ts` does) when `dist` hasn't been built,
 * so this file still works in a fresh checkout before `pnpm exec tsc -b`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_OK } from '../src/exit-codes.js';
import { createFakeEnvironment } from './support/environment.js';

const execFileAsync = promisify(execFile);

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(packageDir, 'examples');
const binPath = join(packageDir, 'dist', 'bin.js');

async function listExamples(): Promise<string[]> {
  const files = await readdir(examplesDir);
  return files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
}

/** Runs `ferrule validate --no-environment -c <path>`, via the built binary if it exists,
 * in-process otherwise. Returns the exit code and whatever landed on stderr. */
async function runValidateNoEnvironment(path: string): Promise<{ code: number; stderr: string }> {
  if (existsSync(binPath)) {
    try {
      const result = await execFileAsync(
        process.execPath,
        [binPath, 'validate', '--no-environment', '-c', path],
        { cwd: packageDir },
      );
      return { code: 0, stderr: result.stderr };
    } catch (error) {
      const e = error as { code?: number; stderr?: string };
      return { code: e.code ?? 1, stderr: e.stderr ?? '' };
    }
  }
  const env = createFakeEnvironment({ argv: ['validate', '--no-environment', '-c', path] });
  const code = await runCli(env);
  return { code, stderr: env.stderrText() };
}

describe('packages/cli/examples (built binary, --no-environment)', () => {
  it('validates every example cleanly, touching no real data directory', async () => {
    const files = await listExamples();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { code, stderr } = await runValidateNoEnvironment(join(examplesDir, file));
      expect(stderr, `${file}: ${stderr}`).toBe('');
      expect(code, `${file} did not validate cleanly`).toBe(EXIT_OK);
    }
  }, 30_000);
});
