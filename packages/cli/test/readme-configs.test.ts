import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_OK } from '../src/exit-codes.js';
import { createFakeEnvironment } from './support/environment.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Pipeline configs shown in the docs: YAML blocks that declare `sources:`. */
async function pipelineBlocks(file: string): Promise<string[]> {
  const text = await readFile(join(repoRoot, file), 'utf8');
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((block) => /^sources:/m.test(block));
}

describe('pipeline configs in the documentation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-readme-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['README.md', 'docs/architecture.md'])('every pipeline in %s validates', async (file) => {
    const blocks = await pipelineBlocks(file);
    expect(blocks.length).toBeGreaterThan(0);
    for (const [i, block] of blocks.entries()) {
      const path = join(dir, `block-${i}.yaml`);
      await writeFile(path, block);
      // Docs reference secrets by name; resolve them from placeholder environment variables.
      const env = createFakeEnvironment({
        argv: ['validate', '--no-environment', '--secrets-env-prefix', 'DOCS_SECRET_', '-c', path],
        env: { DOCS_SECRET_CLICKHOUSE_PASSWORD: 'placeholder' },
      });
      const code = await runCli(env);
      expect(env.stderrText(), `${file} block ${i}`).toBe('');
      expect(code).toBe(EXIT_OK);
    }
  });
});
