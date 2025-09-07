import { describe, expect, it } from 'vitest';
import { FileSystemFaultError, InMemoryFileSystem } from '@ferrule/buffer';

async function readAll(fs: InMemoryFileSystem, path: string): Promise<Uint8Array> {
  const handle = await fs.open(path, 'read');
  try {
    const stat = await handle.stat();
    const buf = new Uint8Array(stat.size);
    await handle.read(buf, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

describe('InMemoryFileSystem basic operations', () => {
  it('creates a file on open("create") and lists it via readdir', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.close();
    expect(await fs.readdir('/d')).toEqual(['a']);
    expect(await fs.exists('/d/a')).toBe(true);
  });

  it('open("read") fails for a missing file', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    await expect(fs.open('/d/missing', 'read')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('open("create-new") fails if the file already exists', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    await (await fs.open('/d/a', 'create-new')).close();
    await expect(fs.open('/d/a', 'create-new')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('write/read round-trips positional data, extending the file as needed', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1, 2, 3]), 0);
    await handle.write(new Uint8Array([9, 9]), 10);
    await handle.close();

    const bytes = await readAll(fs, '/d/a');
    expect(bytes.byteLength).toBe(12);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(bytes.subarray(3, 10))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(bytes.subarray(10, 12))).toEqual([9, 9]);
  });

  it('truncate shrinks and (zero-filled) grows a file', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1, 2, 3, 4]), 0);
    await handle.truncate(2);
    await handle.truncate(5);
    const stat = await handle.stat();
    expect(stat.size).toBe(5);
    await handle.close();
    const bytes = await readAll(fs, '/d/a');
    expect(Array.from(bytes)).toEqual([1, 2, 0, 0, 0]);
  });

  it('rename moves a file and its contents', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([7]), 0);
    await handle.close();
    await fs.rename('/d/a', '/d/b');
    expect(await fs.exists('/d/a')).toBe(false);
    expect(await fs.exists('/d/b')).toBe(true);
    expect(Array.from(await readAll(fs, '/d/b'))).toEqual([7]);
  });

  it('unlink removes a file', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    await (await fs.open('/d/a', 'create')).close();
    await fs.unlink('/d/a');
    expect(await fs.exists('/d/a')).toBe(false);
  });

  it('mkdir is idempotent when recursive, and rejects re-creating without recursive', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/a/b/c', true);
    await expect(fs.mkdir('/a/b/c', true)).resolves.toBeUndefined();
    await expect(fs.mkdir('/a/b/c', false)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('stat reports file size and directory-ness', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array(5), 0);
    await handle.close();
    expect(await fs.stat('/d/a')).toEqual({ size: 5, isDirectory: false });
    expect(await fs.stat('/d')).toEqual({ size: 0, isDirectory: true });
  });
});

describe('InMemoryFileSystem fault injection', () => {
  it('fails the targeted operation with the default error', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    fs.injectFault({ op: 'mkdir' });
    await expect(fs.mkdir('/d/x', true)).rejects.toBeInstanceOf(FileSystemFaultError);
  });

  it('fails only calls matching the given path', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    fs.injectFault({ op: 'unlink', path: '/d/a' });
    await (await fs.open('/d/a', 'create')).close();
    await (await fs.open('/d/b', 'create')).close();
    await expect(fs.unlink('/d/b')).resolves.toBeUndefined();
    await expect(fs.unlink('/d/a')).rejects.toBeInstanceOf(FileSystemFaultError);
  });

  it('expires after the configured number of matches', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    fs.injectFault({ op: 'exists', times: 2 });
    await fs.exists('/d').catch(() => {});
    await fs.exists('/d').catch(() => {});
    await expect(fs.exists('/d')).resolves.toBe(true);
  });

  it('uses a custom error when given', async () => {
    const fs = new InMemoryFileSystem();
    const custom = new Error('disk on fire');
    fs.injectFault({ op: 'readdir', error: custom });
    await expect(fs.readdir('/')).rejects.toBe(custom);
  });

  it('clearFaults removes pending rules', async () => {
    const fs = new InMemoryFileSystem();
    fs.injectFault({ op: 'readdir' });
    fs.clearFaults();
    await expect(fs.readdir('/')).resolves.toEqual([]);
  });
});

describe('InMemoryFileSystem crash simulation', () => {
  it('an unsynced write is dropped entirely in "drop" mode', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1, 2, 3]), 0);
    await handle.fsync();
    await fs.fsyncDir('/d'); // make the file's existence durable too
    await handle.write(new Uint8Array([4, 5, 6]), 3);
    await handle.close();

    fs.crash({ mode: 'drop' });

    expect(Array.from(await readAll(fs, '/d/a'))).toEqual([1, 2, 3]);
  });

  it('fsync makes a write durable across a crash', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1, 2, 3]), 0);
    await handle.fsync();
    await fs.fsyncDir('/d');
    await handle.close();

    fs.crash();

    expect(Array.from(await readAll(fs, '/d/a'))).toEqual([1, 2, 3]);
  });

  it('"tear" mode truncates to somewhere between the synced and live length', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1, 2]), 0);
    await handle.fsync();
    await fs.fsyncDir('/d');
    await handle.write(new Uint8Array([3, 4, 5, 6]), 2);
    await handle.close();

    fs.crash({ mode: 'tear', random: () => 0.5 }); // midpoint of the 4 unsynced bytes -> +2

    const bytes = await readAll(fs, '/d/a');
    expect(bytes.byteLength).toBeGreaterThanOrEqual(2);
    expect(bytes.byteLength).toBeLessThanOrEqual(6);
    expect(Array.from(bytes.subarray(0, 2))).toEqual([1, 2]);
  });

  it('a create not covered by fsyncDir does not survive a crash', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1]), 0);
    await handle.fsync(); // data durable...
    await handle.close();
    // ...but the directory entry was never fsynced.
    fs.crash();
    expect(await fs.exists('/d/a')).toBe(false);
  });

  it('fsyncDir makes a new file durably visible', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1]), 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir('/d');
    fs.crash();
    expect(await fs.exists('/d/a')).toBe(true);
    expect(Array.from(await readAll(fs, '/d/a'))).toEqual([1]);
  });

  it('a rename not covered by fsyncDir reverts on crash', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1]), 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir('/d'); // "a" is durable

    await fs.rename('/d/a', '/d/b');
    fs.crash();

    expect(await fs.exists('/d/a')).toBe(true);
    expect(await fs.exists('/d/b')).toBe(false);
  });

  it('a rename covered by fsyncDir survives a crash', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1]), 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir('/d');

    await fs.rename('/d/a', '/d/b');
    await fs.fsyncDir('/d');
    fs.crash();

    expect(await fs.exists('/d/a')).toBe(false);
    expect(await fs.exists('/d/b')).toBe(true);
  });

  it('an unlink not covered by fsyncDir reverts (the file reappears) on crash', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([42]), 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir('/d');

    await fs.unlink('/d/a');
    fs.crash();

    expect(await fs.exists('/d/a')).toBe(true);
    expect(Array.from(await readAll(fs, '/d/a'))).toEqual([42]);
  });

  it('the filesystem remains usable for further writes after a crash', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/d', true);
    const handle = await fs.open('/d/a', 'create');
    await handle.write(new Uint8Array([1]), 0);
    await handle.fsync();
    await handle.close();
    await fs.fsyncDir('/d');
    fs.crash();

    const reopened = await fs.open('/d/a', 'read-write');
    await reopened.write(new Uint8Array([2]), 1);
    await reopened.fsync();
    await reopened.close();
    expect(Array.from(await readAll(fs, '/d/a'))).toEqual([1, 2]);
  });
});
