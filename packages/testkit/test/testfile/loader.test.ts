import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@ferrule/config';
import { loadTestFile, renderLoadError } from '../../src/testfile/loader.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('loadTestFile', () => {
  it('loads and validates a well-formed test file', async () => {
    const loaded = await loadTestFile(join(fixturesDir, 'passing.test.yaml'));
    expect(loaded.testFile.cases.map((c) => c.name)).toEqual([
      'uppercases the message',
      'skip drops the event, nothing reaches the sink',
      'exact match requires every field',
    ]);
    expect(loaded.configPath).toBe(join(fixturesDir, 'pipeline.yaml'));
  });

  it('applies schema defaults (match: subset, empty inputs/outputs)', async () => {
    const loaded = await loadTestFile(join(fixturesDir, 'passing.test.yaml'));
    const first = loaded.testFile.cases[0]!;
    expect(first.outputs.get('out')!.match).toBe('subset');
  });

  it('throws ConfigError with a rendered code frame for a malformed test file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferrule-testkit-'));
    const file = join(dir, 'bad.test.yaml');
    writeFileSync(file, 'config: ./pipeline.yaml\ncases: []\n');
    await expect(loadTestFile(file)).rejects.toBeInstanceOf(ConfigError);
    try {
      await loadTestFile(file);
      expect.fail('should have thrown');
    } catch (error) {
      const rendered = renderLoadError(error);
      expect(rendered).toContain('cases');
    }
  });

  it('throws ConfigError for invalid YAML syntax', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferrule-testkit-'));
    const file = join(dir, 'bad.test.yaml');
    writeFileSync(file, 'config: [unterminated\n');
    await expect(loadTestFile(file)).rejects.toBeInstanceOf(ConfigError);
  });

  it('renderLoadError falls back to a plain message for a non-ConfigError', () => {
    expect(renderLoadError(new Error('boom'))).toBe('boom');
  });
});
