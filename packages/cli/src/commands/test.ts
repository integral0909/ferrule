import { readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createNullLogger } from '@ferrule/runtime';
import {
  renderHumanReport,
  renderJsonReport,
  renderJunitReport,
  renderLoadError,
  runFerruleTests,
  type ReportSummary,
} from '@ferrule/testkit';
import { withGlobalFlags } from '../args.js';
import type { Command } from '../command.js';
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_TESTS_FAILED } from '../exit-codes.js';
import { buildDefaultRegistry } from '../registry.js';
import { write, writeLine } from '../output.js';

/**
 * Resolves `[tests...]` into concrete test-file paths. A path the caller named explicitly is
 * always included as given (even if it doesn't end in `.test.yaml`); a directory is scanned
 * recursively for `*.test.yaml`/`*.test.yml` files, the convention `@ferrule/testkit`'s own README
 * uses, so scanning a project directory doesn't also try to load its pipeline configs as tests.
 */
async function discoverTestFiles(paths: readonly string[], cwd: string): Promise<string[]> {
  const roots = paths.length > 0 ? paths.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))) : [cwd];
  const files: string[] = [];
  for (const root of roots) {
    const info = await stat(root).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isFile()) files.push(root);
    else if (info.isDirectory()) await walk(root, files);
  }
  return files;
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const path = join(dir, entry);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isDirectory()) await walk(path, out);
    else if (info.isFile() && /\.test\.ya?ml$/i.test(entry)) out.push(path);
  }
}

export const testCommand: Command = {
  spec: withGlobalFlags({
    name: 'test',
    summary: 'Run pipeline test files (and the inline script tests their config references).',
    usage: 'ferrule test [tests...] [options]',
    flags: [
      {
        name: 'reporter',
        type: 'enum',
        enumValues: ['human', 'junit', 'json'],
        default: 'human',
        description: 'Report format.',
      },
      {
        name: 'output',
        type: 'path',
        description: 'Write the report to a file instead of stdout.',
      },
    ],
    positionals: [
      {
        name: 'tests',
        description:
          'Pipeline test YAML files, or directories to scan for them. Defaults to the current directory.',
        variadic: true,
      },
    ],
    examples: [
      'ferrule test',
      'ferrule test pipeline_tests/',
      'ferrule test --reporter junit --output report.xml',
    ],
  }),

  async run(ctx, args) {
    const files = await discoverTestFiles(args.positionals, ctx.env.cwd);
    if (files.length === 0) {
      writeLine(ctx.env.stderr, 'no test files found (looked for *.yaml/*.yml)');
      return EXIT_CONFIG_ERROR;
    }

    const registry = buildDefaultRegistry();
    let summary: ReportSummary;
    try {
      summary = await runFerruleTests(files, { registry, logger: createNullLogger() });
    } catch (error) {
      writeLine(ctx.env.stderr, renderLoadError(error));
      return EXIT_CONFIG_ERROR;
    }

    const reporter = args.flags.get('reporter');
    const report =
      reporter === 'junit'
        ? renderJunitReport(summary)
        : reporter === 'json'
          ? renderJsonReport(summary)
          : renderHumanReport(summary, { color: ctx.color });

    const outputPath = args.flags.get('output');
    if (typeof outputPath === 'string') {
      const path = isAbsolute(outputPath) ? outputPath : resolve(ctx.env.cwd, outputPath);
      await writeFile(path, `${report}\n`, 'utf8');
    } else {
      write(ctx.env.stdout, `${report}\n`);
    }

    return summary.failed > 0 ? EXIT_TESTS_FAILED : EXIT_OK;
  },
};
