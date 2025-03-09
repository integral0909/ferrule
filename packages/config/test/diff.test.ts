import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffConfigs, loadConfig, type LoadedConfig } from '@ferrule/config';
import { testRegistry } from './fixtures.js';

describe('diffConfigs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ferrule-config-diff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(name: string, contents: string): Promise<LoadedConfig> {
    const file = path.join(dir, name);
    await writeFile(file, contents);
    return loadConfig(file, { registry: testRegistry() });
  }

  it('reports added, removed, changed, and unchanged components', async () => {
    const before = await load(
      'before.yaml',
      [
        'sources:',
        '  a:',
        '    type: http',
        '    address: 0.0.0.0:1',
        'sinks:',
        '  keep:',
        '    type: console',
        '    inputs: [a]',
        '  drop:',
        '    type: console',
        '    inputs: [a]',
        '',
      ].join('\n'),
    );
    const after = await load(
      'after.yaml',
      [
        'sources:',
        '  a:',
        '    type: http',
        '    address: 0.0.0.0:2',
        'sinks:',
        '  keep:',
        '    type: console',
        '    inputs: [a]',
        '  added:',
        '    type: console',
        '    inputs: [a]',
        '',
      ].join('\n'),
    );

    const diff = diffConfigs(before, after);
    expect(diff.added).toEqual(['added']);
    expect(diff.removed).toEqual(['drop']);
    expect(diff.changed).toEqual(['a']);
    expect(diff.unchanged).toEqual(['keep']);
  });

  it('reports which global setting groups changed', async () => {
    const before = await load('before.yaml', 'log:\n  level: info\n');
    const after = await load('after.yaml', 'log:\n  level: debug\ndata_dir: /x\n');
    const diff = diffConfigs(before, after);
    expect(diff.globalChanged).toEqual(expect.arrayContaining(['log', 'dataDir']));
    expect(diff.globalChanged).not.toContain('api');
  });

  it('reports no differences for identical configs', async () => {
    const before = await load('a.yaml', 'log:\n  level: info\n');
    const after = await load('b.yaml', 'log:\n  level: info\n');
    const diff = diffConfigs(before, after);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.globalChanged).toEqual([]);
  });
});
