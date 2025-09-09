import { join } from 'node:path';
import { FerruleError } from '@ferrule/core';
import {
  DiskBuffer,
  type DiskBufferOptions,
  type FileSystem,
  type SyncPolicy,
} from '@ferrule/buffer';
import type { EventBuffer, EventBufferFactory, EventBufferStats } from './buffer.js';

export interface DiskBufferFactoryOptions {
  /** Segment size before rollover. Default: the disk buffer's own default (64 MiB). */
  readonly maxSegmentBytes?: number;
  /** Durability policy for every disk buffer this factory creates. Default `always`. */
  readonly sync?: SyncPolicy;
  /** Filesystem override, for tests. */
  readonly fs?: FileSystem;
}

/**
 * An {@link EventBufferFactory} backed by `@ferrule/buffer`'s crash-safe segmented WAL. Each sink
 * gets its own buffer under `<component data dir>/buffer`.
 *
 * Per-sink options come from configuration (`buffer: { type: disk, max_size: 2GiB }` arrives here
 * as `{ maxBufferBytes }`). The buffer always blocks when full: the runtime applies the sink's
 * `when_full` policy on the channel in front of it, so `drop_newest` sheds load *before* the
 * disk rather than failing writes that have already been accepted.
 *
 * Acknowledgement semantics: once a write is durable the buffer finishes the events' upstream
 * finalizers (the source may acknowledge its client), and events read back carry fresh finalizers
 * that acknowledge the buffer itself when the sink finishes them.
 */
export function createDiskBufferFactory(
  defaults: DiskBufferFactoryOptions = {},
): EventBufferFactory {
  return async (options, ctx) => {
    if (ctx.dataDir === undefined) {
      throw new FerruleError(
        'E_BUFFER_NO_DATA_DIR',
        `sink ${JSON.stringify(ctx.componentId)} uses a disk buffer, which requires data_dir to be set`,
      );
    }
    const maxBufferBytes = options['maxBufferBytes'];
    if (
      maxBufferBytes !== undefined &&
      (typeof maxBufferBytes !== 'number' || !(maxBufferBytes > 0))
    ) {
      throw new FerruleError(
        'E_BUFFER_OPTIONS',
        `invalid disk buffer size ${JSON.stringify(maxBufferBytes)}`,
      );
    }

    let events = 0;
    let bytes = 0;
    const diskOptions: DiskBufferOptions = {
      whenFull: 'block',
      metrics: {
        onSizeChanged(b, e) {
          bytes = b;
          events = e;
        },
        onCorruptRecord(kind, segmentId) {
          ctx.logger.warn('skipped a corrupt record while recovering the disk buffer', {
            kind,
            segment: segmentId.toString(),
          });
        },
      },
    };
    if (typeof maxBufferBytes === 'number') diskOptions.maxBufferBytes = maxBufferBytes;
    if (defaults.maxSegmentBytes !== undefined) {
      diskOptions.maxSegmentBytes = defaults.maxSegmentBytes;
    }
    if (defaults.sync !== undefined) diskOptions.sync = defaults.sync;
    if (defaults.fs !== undefined) diskOptions.fs = defaults.fs;

    const handle = await DiskBuffer.open(join(ctx.dataDir, 'buffer'), diskOptions);
    const buffer: EventBuffer = {
      writer: {
        write: (batch, signal) =>
          handle.writer.write(batch, signal === undefined ? {} : { signal }),
        close: () => handle.writer.close(),
      },
      reader: {
        read: async (max, signal) => {
          const batch = await handle.reader.read(max, signal === undefined ? {} : { signal });
          // An empty batch means the reader was closed or the writer closed and everything was read.
          return batch.events.length === 0 ? undefined : [...batch.events];
        },
        close: () => handle.reader.close(),
      },
      stats: (): EventBufferStats => ({ events, bytes }),
      close: () => handle.close(),
    };
    return buffer;
  };
}
