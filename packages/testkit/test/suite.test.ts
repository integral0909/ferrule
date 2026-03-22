import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHumanReport, renderJunitReport, runFerruleTests } from '@ferrule/testkit';
import { buildFixtureRegistry } from './helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('runFerruleTests', () => {
  it('combines pipeline test-file cases and inline script tests into one summary', async () => {
    const summary = await runFerruleTests(
      [
        join(fixturesDir, 'passing.test.yaml'),
        join(fixturesDir, 'script_pipeline_cases.test.yaml'),
      ],
      { registry: buildFixtureRegistry() },
    );

    const pipelineCases = summary.cases.filter((c) => c.kind === 'pipeline');
    const inlineCases = summary.cases.filter((c) => c.kind === 'inline_script');
    expect(pipelineCases.length).toBeGreaterThan(0);
    expect(inlineCases.length).toBe(2);
    expect(inlineCases.some((c) => c.passed)).toBe(true);
    expect(inlineCases.some((c) => !c.passed)).toBe(true);

    // Reporters render without throwing and reflect the summary's totals.
    expect(renderHumanReport(summary)).toContain(`${summary.passed}/${summary.total}`);
    expect(renderJunitReport(summary)).toContain(`tests="${summary.total}"`);
  });
});
