import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTestFile } from '../../src/testfile/loader.js';
import { runTestFile } from '../../src/testfile/runner.js';
import { buildFixtureRegistry } from '../helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('runTestFile', () => {
  it('runs every case in the passing fixture and reports them all passed', async () => {
    const loaded = await loadTestFile(join(fixturesDir, 'passing.test.yaml'));
    const result = await runTestFile(loaded, { registry: buildFixtureRegistry() });
    expect(result.cases).toHaveLength(3);
    for (const c of result.cases) {
      expect(c.passed, `${c.name}: ${c.failures.map((f) => f.message).join('; ')}`).toBe(true);
    }
  });

  it('runs every case in the failing fixture and reports precise failure messages', async () => {
    const loaded = await loadTestFile(join(fixturesDir, 'failing.test.yaml'));
    const result = await runTestFile(loaded, { registry: buildFixtureRegistry() });
    expect(result.cases).toHaveLength(5);
    expect(result.cases.every((c) => !c.passed)).toBe(true);

    const byName = new Map(result.cases.map((c) => [c.name, c]));
    expect(byName.get('wrong expected field value')!.failures[0]!.message).toMatch(
      /message: expected "NOT_WHAT_WE_GOT", got "HELLO"/,
    );
    expect(byName.get('wrong count')!.failures[0]!.message).toMatch(/expected 5 event\(s\), got 2/);
    expect(byName.get('condition is false')!.failures[0]!.message).toMatch(/was false/);
    expect(byName.get('expected none but got one')!.failures[0]!.message).toMatch(
      /expected no events, got 1/,
    );
    expect(byName.get('unknown sink name')!.failures[0]!.message).toMatch(
      /unknown output component/,
    );
  });

  it('reports an unknown input source by name', async () => {
    const loaded = await loadTestFile(join(fixturesDir, 'passing.test.yaml'));
    const patched = {
      ...loaded,
      testFile: {
        ...loaded.testFile,
        cases: [
          {
            name: 'bad source',
            inputs: new Map([['not_a_source', [{ message: 'x' }]]]),
            outputs: new Map(),
          },
        ],
      },
    };
    const result = await runTestFile(patched, { registry: buildFixtureRegistry() });
    expect(result.cases[0]!.passed).toBe(false);
    expect(result.cases[0]!.failures[0]!.message).toMatch(/unknown input component/);
  });

  it('isolates cases from each other (no state carries over)', async () => {
    const loaded = await loadTestFile(join(fixturesDir, 'passing.test.yaml'));
    const result = await runTestFile(loaded, { registry: buildFixtureRegistry() });
    // The second case's sink saw nothing; the third case's sink saw exactly one event, not
    // an accumulation across cases.
    expect(result.cases[1]!.passed).toBe(true);
    expect(result.cases[2]!.passed).toBe(true);
  });
});
