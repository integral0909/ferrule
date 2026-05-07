import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EnvSecretBackend,
  FileSecretBackend,
  MapSecretBackend,
  SecretRegistry,
} from '@ferrule/config';

describe('EnvSecretBackend', () => {
  it('resolves from process.env, optionally under a prefix', async () => {
    process.env['FERRULE_TEST_SECRET'] = 'shh';
    try {
      const backend = new EnvSecretBackend();
      expect(await backend.resolve('FERRULE_TEST_SECRET')).toBe('shh');
      expect(await backend.resolve('MISSING')).toBeUndefined();
    } finally {
      delete process.env['FERRULE_TEST_SECRET'];
    }

    process.env['PREFIX_DB_PASSWORD'] = 'p@ss';
    try {
      const backend = new EnvSecretBackend('PREFIX_');
      expect(await backend.resolve('DB_PASSWORD')).toBe('p@ss');
    } finally {
      delete process.env['PREFIX_DB_PASSWORD'];
    }
  });
});

describe('MapSecretBackend', () => {
  it('resolves from a Map or a plain record', async () => {
    const fromMap = new MapSecretBackend(new Map([['a', '1']]));
    expect(await fromMap.resolve('a')).toBe('1');
    expect(await fromMap.resolve('b')).toBeUndefined();

    const fromRecord = new MapSecretBackend({ a: '1' });
    expect(await fromRecord.resolve('a')).toBe('1');
  });
});

describe('FileSecretBackend', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ferrule-secrets-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a secret from a file, trimming one trailing newline', async () => {
    await writeFile(path.join(dir, 'db_password'), 'hunter2\n');
    const backend = new FileSecretBackend(dir);
    expect(await backend.resolve('db_password')).toBe('hunter2');
  });

  it('returns undefined for a missing secret', async () => {
    const backend = new FileSecretBackend(dir);
    expect(await backend.resolve('missing')).toBeUndefined();
  });

  it('rejects secret names that would escape the directory', async () => {
    const backend = new FileSecretBackend(dir);
    await expect(backend.resolve('../outside')).rejects.toThrow();
    await expect(backend.resolve('a/b')).rejects.toThrow();
  });
});

describe('SecretRegistry', () => {
  it('redacts every registered value, longest first', () => {
    const registry = new SecretRegistry();
    registry.register('short');
    registry.register('short-but-longer');
    const text = registry.redact('the value is short-but-longer here, and short too');
    expect(text).not.toContain('short-but-longer');
    expect(text).not.toContain(' short ');
  });

  it('ignores empty values and ordinary text', () => {
    const registry = new SecretRegistry();
    registry.register('');
    expect(registry.size).toBe(0);
    expect(registry.redact('nothing to redact')).toBe('nothing to redact');
  });

  it('reports membership via has()', () => {
    const registry = new SecretRegistry();
    registry.register('x');
    expect(registry.has('x')).toBe(true);
    expect(registry.has('y')).toBe(false);
  });
});

describe('EnvSecretBackend with an explicit environment', () => {
  it('reads the given environment instead of process.env', async () => {
    const backend = new EnvSecretBackend('APP_', { APP_TOKEN: 's3cret' });
    await expect(backend.resolve('TOKEN')).resolves.toBe('s3cret');
    await expect(backend.resolve('MISSING')).resolves.toBeUndefined();
  });
});
