import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileHandle, FileStat, FileSystem, OpenMode } from './filesystem.js';

const FLAGS: Record<OpenMode, number> = {
  read: fs.constants.O_RDONLY,
  'read-write': fs.constants.O_RDWR,
  create: fs.constants.O_RDWR | fs.constants.O_CREAT,
  'create-new': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
};

class NodeFileHandle implements FileHandle {
  constructor(private readonly handle: fsp.FileHandle) {}

  async read(buffer: Uint8Array, position: number): Promise<number> {
    const { bytesRead } = await this.handle.read(buffer, 0, buffer.byteLength, position);
    return bytesRead;
  }

  async write(buffer: Uint8Array, position: number): Promise<number> {
    const { bytesWritten } = await this.handle.write(buffer, 0, buffer.byteLength, position);
    return bytesWritten;
  }

  truncate(length: number): Promise<void> {
    return this.handle.truncate(length);
  }

  fsync(): Promise<void> {
    return this.handle.sync();
  }

  async stat(): Promise<FileStat> {
    const s = await this.handle.stat();
    return { size: s.size, isDirectory: s.isDirectory() };
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

/** The production {@link FileSystem}, backed by `node:fs/promises`. */
export class NodeFileSystem implements FileSystem {
  async open(path: string, mode: OpenMode): Promise<FileHandle> {
    const handle = await fsp.open(path, FLAGS[mode]);
    return new NodeFileHandle(handle);
  }

  async mkdir(path: string, recursive = false): Promise<void> {
    await fsp.mkdir(path, { recursive });
  }

  readdir(path: string): Promise<string[]> {
    return fsp.readdir(path);
  }

  rename(from: string, to: string): Promise<void> {
    return fsp.rename(from, to);
  }

  unlink(path: string): Promise<void> {
    return fsp.unlink(path);
  }

  async stat(path: string): Promise<FileStat> {
    const s = await fsp.stat(path);
    return { size: s.size, isDirectory: s.isDirectory() };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async fsyncDir(path: string): Promise<void> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(path, fs.constants.O_RDONLY);
    } catch {
      // Some platforms (notably Windows) cannot open a directory at all. There is nothing more
      // we can do to make directory-entry changes durable there; the OS's own guarantees apply.
      return;
    }
    try {
      await handle.sync();
    } catch {
      // Opening succeeded but fsync on a directory descriptor is refused (also platform-
      // dependent). Best-effort, so we swallow this too.
    } finally {
      await handle.close();
    }
  }
}
