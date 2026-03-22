import { loadConfig, type LoadedConfig } from '@ferrule/config';
import type { ComponentRegistry, Logger } from '@ferrule/runtime';
import {
  discoverScriptTransforms,
  runInlineScriptTests,
  type InlineScriptTestOutcome,
} from './testfile/inlineScripts.js';
import { loadTestFile } from './testfile/loader.js';
import { runTestFiles } from './testfile/runner.js';
import {
  inlineScriptReportCases,
  pipelineReportCases,
  summarize,
  type ReportSummary,
} from './reporters/types.js';

/**
 * Top-level entry point for `ferrule test`: loads every test file, runs its pipeline cases, and
 * (once per distinct pipeline config the test files reference) discovers and runs every `script`
 * transform's inline tests — combined into one `ReportSummary` for the reporters in `reporters/`.
 */

export interface RunSuiteOptions {
  readonly registry: ComponentRegistry;
  readonly logger?: Logger;
}

export async function runFerruleTests(
  testFilePaths: readonly string[],
  options: RunSuiteOptions,
): Promise<ReportSummary> {
  const loaded = await Promise.all(testFilePaths.map((p) => loadTestFile(p)));

  const runnerOptions: { registry: ComponentRegistry; logger?: Logger } = {
    registry: options.registry,
  };
  if (options.logger !== undefined) runnerOptions.logger = options.logger;
  const pipelineResults = await runTestFiles(loaded, runnerOptions);

  const configCache = new Map<string, LoadedConfig>();
  const inlineCases: InlineScriptTestOutcome[] = [];
  for (const file of loaded) {
    let config = configCache.get(file.configPath);
    if (config === undefined) {
      config = await loadConfig(file.configPath, { registry: options.registry });
      configCache.set(file.configPath, config);
    }
    const discovered = discoverScriptTransforms(config);
    inlineCases.push(...runInlineScriptTests(discovered));
  }

  return summarize([
    ...pipelineReportCases(pipelineResults),
    ...inlineScriptReportCases(inlineCases),
  ]);
}
