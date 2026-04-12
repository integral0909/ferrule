import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/pkg-info.js';

describe('packageVersion', () => {
  it('matches the version in package.json (read at runtime, not hard-coded)', async () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string };
    expect(packageVersion()).toBe(pkg.version);
  });

  it('returns a plain, cached, non-empty string on repeated calls', () => {
    const first = packageVersion();
    const second = packageVersion();
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});
