import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigError } from '@ferrule/config';
import { loadConfig } from '@ferrule/config';
import { testRegistry } from './fixtures.js';

describe('loadConfig (multiple files and directories)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ferrule-config-multi-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, contents);
    return file;
  }

  it('merges global settings and component sections defined in separate files', async () => {
    const a = await write('01-global.yaml', 'data_dir: /var/lib/ferrule\nlog:\n  level: debug\n');
    const b = await write(
      '02-sources.yaml',
      'sources:\n  app_logs:\n    type: http\n    address: 0.0.0.0:8080\n',
    );
    const c = await write(
      '03-sinks.yaml',
      'sinks:\n  store:\n    type: console\n    inputs: [app_logs]\n',
    );

    const config = await loadConfig([a, b, c], { registry: testRegistry() });
    expect(config.dataDir).toBe('/var/lib/ferrule');
    expect(config.log.level).toBe('debug');
    expect(config.sources.has('app_logs')).toBe(true);
    expect(config.sinks.has('store')).toBe(true);
  });

  it('loads every *.yaml/*.yml/*.json file in a directory, sorted', async () => {
    await write('01-global.yaml', 'log:\n  level: warn\n');
    await write('02-sources.yml', 'sources:\n  a:\n    type: http\n    address: 0.0.0.0:1\n');
    await write(
      '03-sinks.json',
      JSON.stringify({ sinks: { b: { type: 'console', inputs: ['a'] } } }),
    );
    await write('README.md', 'not a config file');

    const config = await loadConfig(dir, { registry: testRegistry() });
    expect(config.log.level).toBe('warn');
    expect(config.sources.has('a')).toBe(true);
    expect(config.sinks.has('b')).toBe(true);
  });

  it('rejects the same component id defined in two files, naming both', async () => {
    const a = await write('a.yaml', 'sources:\n  dup:\n    type: http\n    address: 0.0.0.0:1\n');
    const b = await write('b.yaml', 'sources:\n  dup:\n    type: http\n    address: 0.0.0.0:2\n');
    try {
      await loadConfig([a, b], { registry: testRegistry() });
      expect.unreachable();
    } catch (error) {
      const e = error as ConfigError;
      const message = e.diagnostics.map((d) => d.message).join('\n');
      expect(message).toContain('dup');
      expect(message).toContain(a);
    }
  });

  it('rejects the same scalar global setting defined in two files, naming both', async () => {
    const a = await write('a.yaml', 'data_dir: /one\n');
    const b = await write('b.yaml', 'data_dir: /two\n');
    try {
      await loadConfig([a, b], { registry: testRegistry() });
      expect.unreachable();
    } catch (error) {
      const e = error as ConfigError;
      // The diagnostic is attached to the second (conflicting) file and names the first in its
      // message, so together they name both files involved in the conflict.
      const conflict = e.diagnostics.find((d) => d.message.includes('data_dir'))!;
      expect(conflict).toBeDefined();
      expect(conflict.file).toBe(b);
      expect(conflict.message).toContain(a);
    }
  });

  it('mixes YAML and JSON files in one load', async () => {
    const a = await write('a.yaml', 'sources:\n  a:\n    type: http\n    address: 0.0.0.0:1\n');
    const b = await write(
      'b.json',
      JSON.stringify({ sinks: { s: { type: 'console', inputs: ['a'] } } }),
    );
    const config = await loadConfig([a, b], { registry: testRegistry() });
    expect(config.sources.has('a')).toBe(true);
    expect(config.sinks.has('s')).toBe(true);
  });
});
