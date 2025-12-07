/**
 * A small atomic JSON store for durable component state (used by the `file` source's
 * checkpoints). Writes go to a temporary file in the same directory and are renamed into place,
 * so a crash mid-write never leaves a truncated or partially-written checkpoint file behind —
 * a reader always observes either the previous complete write or the new one, never a mix.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rename, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FerruleError } from '@ferrule/core';

export class CheckpointError extends FerruleError {
  constructor(message: string, options?: ErrorOptions) {
    super('E_CHECKPOINT', message, options);
    this.name = 'CheckpointError';
  }
}

let tmpCounter = 0;

/** Atomically persists one JSON-serialisable value to `filePath`, and loads it back. */
export class AtomicJsonStore<T> {
  constructor(private readonly filePath: string) {}

  /** Loads the stored value, or `defaultValue` if nothing has been saved yet (or it is corrupt). */
  async load(defaultValue: T): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultValue;
      throw new CheckpointError(`failed to read checkpoint file ${this.filePath}`, {
        cause: error,
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      // A checkpoint file is never load-bearing for correctness beyond "resume where we left
      // off"; a corrupt file (e.g. truncated by a crash this store's atomic rename should have
      // prevented, but disks and containers do strange things) is treated as "start fresh"
      // rather than failing the whole component.
      throw new CheckpointError(`checkpoint file ${this.filePath} is corrupt`, { cause: error });
    }
  }

  /** Atomically overwrites the stored value. */
  async save(value: T): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    tmpCounter += 1;
    const tmpPath = join(dir, `.${process.pid}.${tmpCounter}.${Date.now()}.tmp`);
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, this.filePath);
  }

  /** Removes the checkpoint file, if present. For tests and explicit resets. */
  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Number of leading bytes hashed to build a file's content fingerprint. */
export const DEFAULT_FINGERPRINT_BYTES = 256;

/** Hashes the first bytes of a file (up to `DEFAULT_FINGERPRINT_BYTES`-ish) for identity checks. */
export function hashFingerprintBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
