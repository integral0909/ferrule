import { posix } from 'node:path';
import { FileSystemFaultError } from './errors.js';
import type { FileHandle, FileStat, FileSystem, OpenMode } from './filesystem.js';

interface StoredFile {
  bytes: Uint8Array;
  /** Bytes `[0, durableLength)` are guaranteed to survive {@link InMemoryFileSystem.crash}. */
  durableLength: number;
}

type EntryKind = 'file' | 'dir';

/** A namespace change (create/unlink/rename/mkdir) not yet made durable by {@link InMemoryFileSystem.fsyncDir}. */
interface PendingNamespaceOp {
  readonly dirPath: string;
  /** Reverts the live namespace mutation this op performed, as if it never happened. */
  readonly undo: () => void;
}

/** Operations {@link InMemoryFileSystem.injectFault} can target. */
export type FsOperation =
  | 'open'
  | 'read'
  | 'write'
  | 'truncate'
  | 'fsync'
  | 'close'
  | 'stat'
  | 'mkdir'
  | 'readdir'
  | 'rename'
  | 'unlink'
  | 'exists'
  | 'fsyncDir';

/** Describes a fault to inject; see {@link InMemoryFileSystem.injectFault}. */
export interface FaultRule {
  op: FsOperation;
  /** If given, only calls against this exact path trigger the fault. */
  path?: string;
  /** Number of matching calls to fail before the rule expires. Default 1. */
  times?: number;
  /** The error to throw. Defaults to a fresh {@link FileSystemFaultError}. */
  error?: Error | (() => Error);
}

interface ActiveFault extends Required<Pick<FaultRule, 'op'>> {
  path: string | undefined;
  remaining: number;
  error: Error | (() => Error) | undefined;
}

/** How {@link InMemoryFileSystem.crash} treats each live file's unsynced tail. */
export type CrashMode = 'drop' | 'tear';

export interface CrashOptions {
  /**
   * `'drop'` (default) truncates every file back to its last fsynced length, discarding all
   * unsynced writes outright. `'tear'` instead truncates to a length chosen by `random` between
   * the fsynced length and the current length, simulating a write that was partially flushed by
   * the OS page cache before the crash.
   */
  mode?: CrashMode;
  /** Source of randomness for `'tear'` mode, returning a value in `[0, 1)`. Default `Math.random`. */
  random?: () => number;
}

function fsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Normalizes a path to the POSIX form this file system stores. Callers build paths with the
 * platform's `node:path`, so on Windows they arrive with backslashes (`\\buf\\ledger.json`);
 * the in-memory namespace is the same on every platform.
 */
function toPosix(path: string): string {
  const normalized = posix.normalize(path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'));
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function enoent(path: string): NodeJS.ErrnoException {
  return fsError('ENOENT', `ENOENT: no such file or directory, '${path}'`);
}

function eexist(path: string): NodeJS.ErrnoException {
  return fsError('EEXIST', `EEXIST: file already exists, '${path}'`);
}

function eisdir(path: string): NodeJS.ErrnoException {
  return fsError('EISDIR', `EISDIR: illegal operation on a directory, '${path}'`);
}

function enotdir(path: string): NodeJS.ErrnoException {
  return fsError('ENOTDIR', `ENOTDIR: not a directory, '${path}'`);
}

/** Yields to the microtask queue, keeping every operation genuinely asynchronous like real I/O. */
function tick(): Promise<void> {
  return Promise.resolve();
}

/**
 * An in-memory {@link FileSystem} that can simulate a crash: {@link crash} drops or tears every
 * write that was not followed by {@link FileHandle.fsync}, and reverts any create, rename,
 * mkdir, or unlink whose containing directory was not followed by {@link fsyncDir}. It can also
 * fail specific operations on demand via {@link injectFault}.
 *
 * This is what makes the crash-safety tests possible: the disk buffer runs unmodified against
 * this filesystem, and the tests assert its recovery logic is correct no matter where a crash is
 * simulated.
 */
export class InMemoryFileSystem implements FileSystem {
  private readonly entries = new Map<string, EntryKind>();
  private readonly files = new Map<string, StoredFile>();
  private pending: PendingNamespaceOp[] = [];
  private faults: ActiveFault[] = [];
  private openHandles = 0;

  constructor() {
    this.entries.set('/', 'dir');
  }

  // --- Fault injection ---------------------------------------------------------------------

  /** Schedules an operation to fail. See {@link FaultRule}. */
  injectFault(rule: FaultRule): void {
    this.faults.push({
      op: rule.op,
      path: rule.path === undefined ? undefined : toPosix(rule.path),
      remaining: rule.times ?? 1,
      error: rule.error,
    });
  }

  clearFaults(): void {
    this.faults = [];
  }

  private checkFault(op: FsOperation, path?: string): void {
    const index = this.faults.findIndex(
      (f) => f.op === op && (f.path === undefined || f.path === path),
    );
    if (index === -1) return;
    const rule = this.faults[index]!;
    rule.remaining--;
    if (rule.remaining <= 0) this.faults.splice(index, 1);
    const built = typeof rule.error === 'function' ? rule.error() : rule.error;
    throw (
      built ??
      new FileSystemFaultError(`injected fault: ${op}${path === undefined ? '' : ` on ${path}`}`)
    );
  }

  // --- Crash simulation ----------------------------------------------------------------------

  /**
   * Simulates power loss: reverts every namespace change (create/rename/unlink/mkdir) whose
   * directory was never fsynced, then truncates every remaining file's unsynced tail per
   * `options.mode`. After this call the filesystem represents "what a fresh process would see
   * after mounting the disk again."
   */
  crash(options: CrashOptions = {}): void {
    const mode = options.mode ?? 'drop';
    const random = options.random ?? Math.random;

    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i]!.undo();
    }
    this.pending = [];

    for (const [path, kind] of this.entries) {
      if (kind !== 'file') continue;
      const file = this.files.get(path);
      if (file === undefined) continue;
      const tearPoint =
        mode === 'drop'
          ? file.durableLength
          : file.durableLength +
            Math.floor(random() * (file.bytes.length - file.durableLength + 1));
      file.bytes = file.bytes.slice(0, tearPoint);
      file.durableLength = file.bytes.length;
    }
  }

  // --- FileSystem --------------------------------------------------------------------------

  async open(path: string, mode: OpenMode): Promise<FileHandle> {
    path = toPosix(path);
    this.checkFault('open', path);
    await tick();
    const existingKind = this.entries.get(path);
    if (mode === 'read' || mode === 'read-write') {
      if (existingKind === undefined) throw enoent(path);
      if (existingKind !== 'file') throw eisdir(path);
    } else if (mode === 'create-new' && existingKind !== undefined) {
      throw eexist(path);
    } else if (existingKind !== undefined && existingKind !== 'file') {
      throw eisdir(path);
    }

    if (existingKind === undefined) {
      const parent = posix.dirname(path);
      if (!this.entries.has(parent)) throw enoent(path);
      const stored: StoredFile = { bytes: new Uint8Array(0), durableLength: 0 };
      this.entries.set(path, 'file');
      this.files.set(path, stored);
      this.pending.push({
        dirPath: parent,
        undo: () => {
          this.entries.delete(path);
          this.files.delete(path);
        },
      });
    }
    this.openHandles++;
    return new MemoryFileHandle(this, path);
  }

  /** @internal used by {@link MemoryFileHandle} */
  requireFile(path: string): StoredFile {
    path = toPosix(path);
    const file = this.files.get(path);
    if (file === undefined) throw enoent(path);
    return file;
  }

  /** @internal used by {@link MemoryFileHandle} */
  handleClosed(): void {
    this.openHandles--;
  }

  /** @internal used by {@link MemoryFileHandle} */
  fault(op: FsOperation, path: string): void {
    path = toPosix(path);
    this.checkFault(op, path);
  }

  async mkdir(path: string, recursive = false): Promise<void> {
    path = toPosix(path);
    this.checkFault('mkdir', path);
    await tick();
    const existing = this.entries.get(path);
    if (existing === 'dir') {
      if (recursive) return;
      throw eexist(path);
    }
    if (existing === 'file') throw eexist(path);

    const parent = posix.dirname(path);
    if (parent !== path && !this.entries.has(parent)) {
      if (!recursive) throw enoent(parent);
      await this.mkdir(parent, true);
    }
    this.entries.set(path, 'dir');
    this.pending.push({ dirPath: parent, undo: () => this.entries.delete(path) });
  }

  async readdir(path: string): Promise<string[]> {
    path = toPosix(path);
    this.checkFault('readdir', path);
    await tick();
    if (this.entries.get(path) !== 'dir') {
      throw this.entries.has(path) ? enotdir(path) : enoent(path);
    }
    const names: string[] = [];
    for (const entryPath of this.entries.keys()) {
      if (entryPath === '/' || posix.dirname(entryPath) !== path) continue;
      names.push(entryPath.slice(path.length + (path.endsWith('/') ? 0 : 1)));
    }
    names.sort();
    return names;
  }

  async rename(from: string, to: string): Promise<void> {
    from = toPosix(from);
    to = toPosix(to);
    this.checkFault('rename', from);
    await tick();
    const fromKind = this.entries.get(from);
    if (fromKind === undefined) throw enoent(from);
    const fromFile = fromKind === 'file' ? this.files.get(from) : undefined;
    const toPrevKind = this.entries.get(to);
    const toPrevFile = toPrevKind === 'file' ? this.files.get(to) : undefined;

    this.entries.delete(from);
    this.files.delete(from);
    this.entries.set(to, fromKind);
    if (fromFile !== undefined) this.files.set(to, fromFile);
    else this.files.delete(to);

    this.pending.push({
      dirPath: posix.dirname(from),
      undo: () => {
        this.entries.set(from, fromKind);
        if (fromFile !== undefined) this.files.set(from, fromFile);
      },
    });
    this.pending.push({
      dirPath: posix.dirname(to),
      undo: () => {
        if (toPrevKind === undefined) {
          this.entries.delete(to);
          this.files.delete(to);
        } else {
          this.entries.set(to, toPrevKind);
          if (toPrevFile !== undefined) this.files.set(to, toPrevFile);
          else this.files.delete(to);
        }
      },
    });
  }

  async unlink(path: string): Promise<void> {
    path = toPosix(path);
    this.checkFault('unlink', path);
    await tick();
    const kind = this.entries.get(path);
    if (kind === undefined) throw enoent(path);
    if (kind !== 'file') throw eisdir(path);
    const file = this.files.get(path);
    this.entries.delete(path);
    this.files.delete(path);
    this.pending.push({
      dirPath: posix.dirname(path),
      undo: () => {
        this.entries.set(path, kind);
        if (file !== undefined) this.files.set(path, file);
      },
    });
  }

  async stat(path: string): Promise<FileStat> {
    path = toPosix(path);
    this.checkFault('stat', path);
    await tick();
    const kind = this.entries.get(path);
    if (kind === undefined) throw enoent(path);
    if (kind === 'dir') return { size: 0, isDirectory: true };
    return { size: this.files.get(path)!.bytes.byteLength, isDirectory: false };
  }

  async exists(path: string): Promise<boolean> {
    path = toPosix(path);
    this.checkFault('exists', path);
    await tick();
    return this.entries.has(path);
  }

  async fsyncDir(path: string): Promise<void> {
    path = toPosix(path);
    this.checkFault('fsyncDir', path);
    await tick();
    if (this.entries.get(path) !== 'dir') return;
    this.pending = this.pending.filter((op) => op.dirPath !== path);
  }
}

class MemoryFileHandle implements FileHandle {
  private closed = false;

  constructor(
    private readonly fs: InMemoryFileSystem,
    private readonly path: string,
  ) {}

  private checkOpen(): void {
    if (this.closed) throw new FileSystemFaultError(`file handle for '${this.path}' is closed`);
  }

  async read(buffer: Uint8Array, position: number): Promise<number> {
    this.checkOpen();
    this.fs.fault('read', this.path);
    await tick();
    const stored = this.fs.requireFile(this.path);
    const available = Math.max(0, stored.bytes.byteLength - position);
    const n = Math.min(buffer.byteLength, available);
    if (n > 0) buffer.set(stored.bytes.subarray(position, position + n));
    return n;
  }

  async write(buffer: Uint8Array, position: number): Promise<number> {
    this.checkOpen();
    this.fs.fault('write', this.path);
    await tick();
    const stored = this.fs.requireFile(this.path);
    const end = position + buffer.byteLength;
    if (end > stored.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(stored.bytes);
      stored.bytes = grown;
    }
    stored.bytes.set(buffer, position);
    return buffer.byteLength;
  }

  async truncate(length: number): Promise<void> {
    this.checkOpen();
    this.fs.fault('truncate', this.path);
    await tick();
    const stored = this.fs.requireFile(this.path);
    if (length <= stored.bytes.byteLength) {
      stored.bytes = stored.bytes.slice(0, length);
    } else {
      const grown = new Uint8Array(length);
      grown.set(stored.bytes);
      stored.bytes = grown;
    }
    stored.durableLength = Math.min(stored.durableLength, length);
  }

  async fsync(): Promise<void> {
    this.checkOpen();
    this.fs.fault('fsync', this.path);
    await tick();
    const stored = this.fs.requireFile(this.path);
    stored.durableLength = stored.bytes.byteLength;
  }

  async stat(): Promise<FileStat> {
    this.checkOpen();
    this.fs.fault('stat', this.path);
    await tick();
    const stored = this.fs.requireFile(this.path);
    return { size: stored.bytes.byteLength, isDirectory: false };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.fs.fault('close', this.path);
    await tick();
    this.closed = true;
    this.fs.handleClosed();
  }
}
