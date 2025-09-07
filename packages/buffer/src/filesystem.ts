/**
 * A small filesystem abstraction that every disk buffer operation is routed through.
 *
 * Two implementations exist: {@link NodeFileSystem} (backed by `node:fs/promises`) and, in
 * `memory-filesystem.ts`, an in-memory implementation that can simulate crashes for testing.
 * Routing all I/O through this interface is what makes the crash-safety tests possible: they run
 * the exact same disk buffer code against a filesystem that can tear writes and drop unsynced
 * data on command.
 */

/** Result of {@link FileSystem.stat} / {@link FileHandle.stat}. */
export interface FileStat {
  readonly size: number;
  readonly isDirectory: boolean;
}

/** How {@link FileSystem.open} should treat an existing or missing file. */
export type OpenMode =
  /** Fails if the file does not exist. Read-only. */
  | 'read'
  /** Fails if the file does not exist. Read and write. */
  | 'read-write'
  /** Creates the file if it does not exist (without truncating an existing one). Read and write. */
  | 'create'
  /** Creates the file; fails if it already exists. Read and write. */
  | 'create-new';

/** An open file. Reads and writes are positional; there is no implicit cursor. */
export interface FileHandle {
  /** Reads into `buffer` starting at `position`. Returns the number of bytes actually read. */
  read(buffer: Uint8Array, position: number): Promise<number>;
  /** Writes `buffer` starting at `position`. Returns the number of bytes actually written. */
  write(buffer: Uint8Array, position: number): Promise<number>;
  truncate(length: number): Promise<void>;
  /** Flushes this file's data and metadata to durable storage (`fsync`). */
  fsync(): Promise<void>;
  stat(): Promise<FileStat>;
  close(): Promise<void>;
}

/** Routes every filesystem operation the buffer performs. */
export interface FileSystem {
  open(path: string, mode: OpenMode): Promise<FileHandle>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  /**
   * Flushes the directory's own metadata (its entries) to durable storage. Required after
   * `rename`/`unlink`/creating a file for the change to survive a crash — see `FORMAT.md`.
   * Best-effort: platforms where directories cannot be opened for this purpose (this varies even
   * across POSIX systems, and generally does not apply on Windows) treat this as a no-op rather
   * than an error, since there is nothing more the implementation can do.
   */
  fsyncDir(path: string): Promise<void>;
}
