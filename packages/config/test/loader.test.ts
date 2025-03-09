import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, MapSecretBackend } from '@ferrule/config';
import { testRegistry } from './fixtures.js';

describe('loadConfig (single file)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ferrule-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, contents);
    return file;
  }

  it('loads a complete valid config with defaults filled in', async () => {
    const file = await write(
      'config.yaml',
      [
        'data_dir: /var/lib/ferrule',
        'log:',
        '  level: debug',
        'sources:',
        '  app_logs:',
        '    type: http',
        '    address: 0.0.0.0:8080',
        'transforms:',
        '  shape:',
        '    type: script',
        '    inputs: app_logs',
        '    source: ".service = 1"',
        'sinks:',
        '  store:',
        '    type: console',
        '    inputs: [shape]',
        '',
      ].join('\n'),
    );

    const config = await loadConfig(file, { registry: testRegistry() });
    expect(config.dataDir).toBe('/var/lib/ferrule');
    expect(config.log).toEqual({ level: 'debug', format: 'text' });
    expect(config.api).toEqual({ enabled: false });
    expect(config.healthchecks).toEqual({ enabled: true, timeout: 5000 });
    expect(config.sources.size).toBe(1);
    expect(config.transforms.size).toBe(1);
    expect(config.sinks.size).toBe(1);
    const source = config.sources.get('app_logs')!;
    expect(source.kind).toBe('source');
    expect(source.type).toBe('http');
    expect(source.location.file).toBe(file);
    const sink = config.sinks.get('store')!;
    expect(sink.inputs).toEqual([{ id: 'shape' }]);
    expect(config.components).toHaveLength(3);
  });

  it('collects multiple diagnostics in one pass, each with a precise location', async () => {
    const file = await write(
      'config.yaml',
      ['nope: 1', 'log:', '  level: verbose', 'sources:', '  badtype:', '    type: htpp', ''].join(
        '\n',
      ),
    );

    await expect(loadConfig(file, { registry: testRegistry() })).rejects.toThrow(ConfigError);
    try {
      await loadConfig(file, { registry: testRegistry() });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const e = error as ConfigError;
      expect(e.diagnostics.length).toBeGreaterThanOrEqual(3);
      const messages = e.diagnostics.map((d) => d.message);
      expect(messages.some((m) => m.includes('nope'))).toBe(true);
      expect(messages.some((m) => m.includes('log.level'))).toBe(true);
      expect(messages.some((m) => m.includes('htpp'))).toBe(true);
      const levelDiag = e.diagnostics.find((d) => d.message.includes('log.level'))!;
      expect(levelDiag.range?.start.line).toBe(3);
      expect(e.sources.get(file)).toBeDefined();
    }
  });

  it('rejects a component id that does not match the component-id pattern', async () => {
    const file = await write(
      'config.yaml',
      ['sources:', '  Bad-Id:', '    type: http', '    address: 0.0.0.0:8080', ''].join('\n'),
    );
    try {
      await loadConfig(file, { registry: testRegistry() });
      expect.unreachable();
    } catch (error) {
      const e = error as ConfigError;
      expect(e.diagnostics.some((d) => d.message.includes('component ID'))).toBe(true);
    }
  });

  it('rejects a duplicate component id used across two different sections', async () => {
    const file = await write(
      'config.yaml',
      [
        'sources:',
        '  dup:',
        '    type: http',
        '    address: 0.0.0.0:8080',
        'sinks:',
        '  dup:',
        '    type: console',
        '    inputs: [dup]',
        '',
      ].join('\n'),
    );
    await expect(loadConfig(file, { registry: testRegistry() })).rejects.toThrow(ConfigError);
  });

  it('interpolates ${VAR} and ${secret:NAME}, and redacts secrets from the dump', async () => {
    const file = await write(
      'config.yaml',
      [
        'data_dir: ${DATA_DIR:-/default}',
        'sinks:',
        '  store:',
        '    type: clickhouse',
        '    inputs: [x]',
        '    endpoint: https://clickhouse.internal',
        '    table: logs',
        '    auth:',
        '      password: ${secret:CH_PASSWORD}',
        '',
      ].join('\n'),
    );
    const config = await loadConfig(file, {
      registry: testRegistry(),
      env: {},
      secretBackend: new MapSecretBackend({ CH_PASSWORD: 'hunter2' }),
    });
    expect(config.dataDir).toBe('/default');
    expect(config.secrets.has('hunter2')).toBe(true);
    const dump = config.redactedDump();
    expect(dump).not.toContain('hunter2');
    expect(dump).toContain('**REDACTED**');
  });

  it('rejects a config whose top level is not a mapping', async () => {
    const file = await write('config.yaml', '- just\n- a list\n');
    await expect(loadConfig(file, { registry: testRegistry() })).rejects.toThrow(ConfigError);
  });

  it('surfaces a YAML syntax error as a ConfigError diagnostic with a line number', async () => {
    const file = await write('config.yaml', 'a:\n\tb: 1\n');
    try {
      await loadConfig(file, { registry: testRegistry() });
      expect.unreachable();
    } catch (error) {
      const e = error as ConfigError;
      expect(e.diagnostics[0]?.range?.start.line).toBe(2);
    }
  });

  it('accepts Windows-style CRLF line endings', async () => {
    const file = await write(
      'config.yaml',
      ['sources:', '  a:', '    type: http', '    address: 0.0.0.0:1', ''].join('\r\n'),
    );
    const config = await loadConfig(file, { registry: testRegistry() });
    expect(config.sources.has('a')).toBe(true);
  });

  it('produces a redactedDump() that itself loads cleanly and matches the original shape', async () => {
    const file = await write(
      'config.yaml',
      [
        'data_dir: /var/lib/ferrule',
        'sources:',
        '  a:',
        '    type: statsd',
        '    address: 0.0.0.0:9125',
        'sinks:',
        '  store:',
        '    type: clickhouse',
        '    inputs: [a]',
        '    endpoint: https://clickhouse.internal',
        '    table: logs',
        '    auth:',
        '      password: nonsecret-for-this-test',
        '',
      ].join('\n'),
    );
    const config = await loadConfig(file, { registry: testRegistry() });
    const dumpFile = await write('dump.yaml', config.redactedDump());
    const reloaded = await loadConfig(dumpFile, { registry: testRegistry() });
    expect(reloaded.dataDir).toBe(config.dataDir);
    expect(reloaded.sources.get('a')?.options).toEqual(config.sources.get('a')?.options);
    // The password was redacted, so it no longer parses as the original secret string.
    expect(reloaded.sinks.get('store')?.rawOptions).not.toEqual(
      config.sinks.get('store')?.rawOptions,
    );
  });
});
