import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvSecretBackend, FileSecretBackend } from '@ferrule/config';
import { parseArgs, type CommandSpec } from '../src/args.js';
import {
  configPathsFromFlags,
  expandConfigPathsForWatch,
  secretBackendFromFlags,
  topologyOverridesFromFlags,
} from '../src/config-support.js';
import { UsageError } from '../src/errors.js';

const SPEC: CommandSpec = {
  name: 'test',
  summary: '',
  flags: [
    { name: 'config', short: 'c', type: 'path', repeatable: true, description: '' },
    { name: 'secrets-dir', type: 'path', description: '' },
    { name: 'secrets-env-prefix', type: 'string', description: '' },
    { name: 'data-dir', type: 'path', description: '' },
    { name: 'healthchecks', type: 'boolean', negatable: true, default: true, description: '' },
    { name: 'shutdown-timeout', type: 'duration', description: '' },
  ],
};

function parse(argv: string[]) {
  const result = parseArgs(SPEC, argv);
  if (!result.ok) throw new Error(result.message);
  return result.args;
}

describe('secretBackendFromFlags', () => {
  it('returns undefined when neither flag is given', () => {
    expect(secretBackendFromFlags(parse([]))).toBeUndefined();
  });

  it('builds a FileSecretBackend for --secrets-dir', () => {
    const backend = secretBackendFromFlags(parse(['--secrets-dir', '/tmp/secrets']));
    expect(backend).toBeInstanceOf(FileSecretBackend);
  });

  it('builds an EnvSecretBackend for --secrets-env-prefix', () => {
    const backend = secretBackendFromFlags(parse(['--secrets-env-prefix', 'FERRULE_']));
    expect(backend).toBeInstanceOf(EnvSecretBackend);
  });

  it('rejects both flags being given at once', () => {
    expect(() =>
      secretBackendFromFlags(parse(['--secrets-dir', 'x', '--secrets-env-prefix', 'y'])),
    ).toThrow(UsageError);
  });
});

describe('configPathsFromFlags', () => {
  it('resolves relative paths against cwd', () => {
    const paths = configPathsFromFlags(parse(['-c', 'a.yaml', '-c', 'b.yaml']), '/work/dir');
    expect(paths).toEqual(['/work/dir/a.yaml', '/work/dir/b.yaml']);
  });

  it('leaves absolute paths untouched', () => {
    const paths = configPathsFromFlags(parse(['-c', '/abs/pipeline.yaml']), '/work/dir');
    expect(paths).toEqual(['/abs/pipeline.yaml']);
  });

  it('throws a UsageError when no -c/--config is given', () => {
    expect(() => configPathsFromFlags(parse([]), '/work/dir')).toThrow(UsageError);
  });
});

describe('topologyOverridesFromFlags', () => {
  it('is empty when no override flags are given', () => {
    expect(topologyOverridesFromFlags(parse([]), '/work')).toEqual({});
  });

  it('reads --data-dir, resolved against cwd', () => {
    const overrides = topologyOverridesFromFlags(parse(['--data-dir', 'data']), '/work');
    expect(overrides.dataDir).toBe(resolve('/work', 'data'));
  });

  it('--no-healthchecks sets disableHealthchecks', () => {
    const overrides = topologyOverridesFromFlags(parse(['--no-healthchecks']), '/work');
    expect(overrides.disableHealthchecks).toBe(true);
  });

  it('--healthchecks (the default) does not set disableHealthchecks', () => {
    const overrides = topologyOverridesFromFlags(parse(['--healthchecks']), '/work');
    expect(overrides.disableHealthchecks).toBeUndefined();
  });

  it('reads --shutdown-timeout as milliseconds', () => {
    const overrides = topologyOverridesFromFlags(parse(['--shutdown-timeout', '5s']), '/work');
    expect(overrides.shutdownDeadlineMs).toBe(5000);
  });
});

describe('expandConfigPathsForWatch', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-cli-watch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a single file path unchanged', async () => {
    const file = join(dir, 'a.yaml');
    await writeFile(file, 'sources: {}\nsinks: {}\n', 'utf8');
    expect(await expandConfigPathsForWatch([file])).toEqual([file]);
  });

  it('expands a directory into its sorted *.yaml/*.yml/*.json files', async () => {
    await writeFile(join(dir, 'b.yaml'), '', 'utf8');
    await writeFile(join(dir, 'a.json'), '', 'utf8');
    await writeFile(join(dir, 'ignore.txt'), '', 'utf8');
    const files = await expandConfigPathsForWatch([dir]);
    expect(files).toEqual([join(dir, 'a.json'), join(dir, 'b.yaml')]);
  });

  it('silently skips a path that no longer exists', async () => {
    expect(await expandConfigPathsForWatch([join(dir, 'nope.yaml')])).toEqual([]);
  });

  it('handles a mix of files and directories', async () => {
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await writeFile(join(sub, 'x.yaml'), '', 'utf8');
    const top = join(dir, 'top.yaml');
    await writeFile(top, '', 'utf8');
    const files = await expandConfigPathsForWatch([top, sub]);
    expect(files).toEqual([top, join(sub, 'x.yaml')]);
  });
});
