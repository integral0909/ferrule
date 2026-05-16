/**
 * Regenerates `docs/reference/components.md` from every builtin source, operator, and sink
 * definition. Run with `pnpm run docs:generate` (writes the file) or `pnpm run docs:check`
 * (`--check`: regenerates into memory and fails without writing if the committed file differs —
 * this is what CI runs to catch a component whose docs weren't regenerated after a schema
 * change).
 *
 * Runnable directly: `node --experimental-strip-types tools/generate-component-docs.ts`.
 * `tools/` is a private workspace package: type-checking resolves `@ferrule/*` to package
 * sources, while running it uses the built `dist/` output, so run `pnpm exec tsc -b` first
 * (both `docs:generate` and `docs:check` do this themselves).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { builtinOperators } from '@ferrule/operators';
import { builtinSinks } from '@ferrule/sinks';
import { builtinSources } from '@ferrule/sources';
// This file (unlike the packages above) is run directly as TypeScript source, not compiled
// output, so the sibling import needs the real `.ts` extension Node's type-stripping resolves.
import { renderComponentsDoc } from './component-docs.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const outputPath = join(repoRoot, 'docs', 'reference', 'components.md');

/** Formats with the repo's own Prettier config, so generated output always matches what
 * `prettier --check` (part of `pnpm run check`) expects — notably Markdown table column
 * alignment, which `renderComponentsDoc` itself doesn't bother computing. */
async function formatMarkdown(text: string): Promise<string> {
  const config = (await prettier.resolveConfig(outputPath)) ?? {};
  return prettier.format(text, { ...config, filepath: outputPath });
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const rendered = await formatMarkdown(
    renderComponentsDoc(builtinSources(), builtinOperators(), builtinSinks()),
  );

  if (!check) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, rendered, 'utf8');
    process.stdout.write(`wrote ${outputPath}\n`);
    return;
  }

  let existing: string | undefined;
  try {
    existing = await readFile(outputPath, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing !== rendered) {
    process.stderr.write(
      `${outputPath} is out of date with the builtin component definitions.\n` +
        'Run `pnpm run docs:generate` and commit the result.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${outputPath} is up to date.\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
