import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@ferrule/config';
import {
  discoverScriptTransforms,
  runInlineScriptTests,
} from '../../src/testfile/inlineScripts.js';
import { buildFixtureRegistry } from '../helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('discoverScriptTransforms / runInlineScriptTests', () => {
  it('finds every type: script transform and runs its inline tests', async () => {
    const config = await loadConfig(join(fixturesDir, 'script_pipeline.yaml'), {
      registry: buildFixtureRegistry(),
    });
    const discovered = discoverScriptTransforms(config);
    expect(discovered.map((d) => d.componentId)).toEqual(['shape']);

    const outcomes = runInlineScriptTests(discovered);
    expect(outcomes).toHaveLength(2);
    const byName = new Map(outcomes.map((o) => [o.result?.name, o]));
    expect(byName.get('normalises level')!.result!.passed).toBe(true);
    expect(byName.get('wrong expectation on purpose')!.result!.passed).toBe(false);
  });

  it('a config with no script transforms discovers nothing', async () => {
    const config = await loadConfig(join(fixturesDir, 'pipeline.yaml'), {
      registry: buildFixtureRegistry(),
    });
    expect(discoverScriptTransforms(config)).toEqual([]);
  });

  it('a script that fails to compile is reported as a compile error, not a thrown exception', () => {
    const outcomes = runInlineScriptTests([
      { componentId: 'broken', source: '.a = ', file: undefined },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.result).toBeUndefined();
    expect(outcomes[0]!.compileError).toMatch(/error\[/);
  });
});
