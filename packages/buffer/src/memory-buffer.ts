import { BatchNotifier, type DeliveryStatus, type Event } from '@ferrule/core';
import { BufferClosedError, BufferFullError } from './errors.js';
import type {
  BufferHandle,
  BufferMetricsObserver,
  BufferReader,
  BufferWriter,
  ReadBatch,
  ReadOptions,
  WhenFull,
  WriteOptions,
} from './types.js';
import { wakeAll, waitFor, type Waiter } from './waiters.js';

/** Options for {@link createMemoryBuffer}. */
export interface MemoryBufferOptions {
  /** Maximum number of events the buffer may hold at once (read but unacknowledged counts too). Default unbounded. */
  maxEvents?: number;
  /** Maximum total estimated bytes the buffer may hold at once. Default unbounded. */
  maxBytes?: number;
  /** Default `'block'`. */
  whenFull?: WhenFull;
  metrics?: BufferMetricsObserver;
}

interface QueuedItem {
  event: Event;
  size: number;
}

/**
 * A bounded, in-memory buffer with the same {@link BufferWriter}/{@link BufferReader} interface
 * as {@link DiskBuffer}, so the runtime can swap between them without touching call sites. It has
 * no persistence or crash recovery: everything is lost on process exit.
 */
export function createMemoryBuffer(options: MemoryBufferOptions = {}): BufferHandle {
  const maxEvents = options.maxEvents ?? Infinity;
  const maxBytes = options.maxBytes ?? Infinity;
  const whenFull = options.whenFull ?? 'block';
  const metrics = options.metrics;

  const queue: QueuedItem[] = [];
  let pendingEvents = 0;
  let pendingBytes = 0;
  let closed = false;

  const writerWaiters: Waiter[] = [];
  const readerWaiters: Waiter[] = [];

  function reportSize(): void {
    metrics?.onSizeChanged?.(pendingBytes, pendingEvents, pendingEvents > 0 ? 1 : 0);
  }

  function hasSpace(count: number, bytes: number): boolean {
    return pendingEvents + count <= maxEvents && pendingBytes + bytes <= maxBytes;
  }

  function release(size: number): void {
    pendingEvents--;
    pendingBytes -= size;
    metrics?.onAck?.(1, size);
    reportSize();
    wakeAll(writerWaiters);
  }

  const writer: BufferWriter = {
    get closed() {
      return closed;
    },

    async write(events: readonly Event[], writeOptions: WriteOptions = {}): Promise<void> {
      if (closed) throw new BufferClosedError();
      if (events.length === 0) return;
      const sizes = events.map((e) => e.estimatedSize());
      const totalBytes = sizes.reduce((a, b) => a + b, 0);

      for (;;) {
        if (closed) throw new BufferClosedError();
        if (hasSpace(events.length, totalBytes)) break;
        if (whenFull === 'drop_newest') {
          metrics?.onDropNewest?.(events.length, totalBytes);
          throw new BufferFullError(
            `memory buffer is full: ${pendingEvents}/${maxEvents} events, ${pendingBytes}/${maxBytes} bytes`,
          );
        }
        await waitFor(writerWaiters, writeOptions.signal);
      }

      for (let i = 0; i < events.length; i++) {
        queue.push({ event: events[i]!, size: sizes[i]! });
      }
      pendingEvents += events.length;
      pendingBytes += totalBytes;
      metrics?.onWrite?.(events.length, totalBytes);
      reportSize();
      wakeAll(readerWaiters);

      // The memory buffer has nothing to flush; "durable" is immediate.
      for (const event of events) event.metadata.finalizers.finish('delivered');
    },

    flush(): Promise<void> {
      // Nothing is ever buffered undurably in memory.
      return Promise.resolve();
    },

    close(): Promise<void> {
      if (!closed) {
        closed = true;
        wakeAll(writerWaiters);
        wakeAll(readerWaiters);
      }
      return Promise.resolve();
    },
  };

  const reader: BufferReader = {
    get closed() {
      return closed;
    },

    async read(maxEventsToRead: number, readOptions: ReadOptions = {}): Promise<ReadBatch> {
      if (maxEventsToRead <= 0) throw new RangeError('maxEvents must be positive');
      for (;;) {
        if (queue.length > 0) break;
        if (closed) return { events: [], ackAll: () => {} };
        await waitFor(readerWaiters, readOptions.signal);
      }

      const taken = queue.splice(0, maxEventsToRead);
      let bytes = 0;
      for (const item of taken) {
        bytes += item.size;
        const notifier = new BatchNotifier();
        const finalizer = notifier.createFinalizer();
        item.event.metadata.finalizers.add(finalizer);
        notifier.seal();
        void notifier.completion.then(() => release(item.size));
      }
      metrics?.onRead?.(taken.length, bytes);

      return {
        events: taken.map((item) => item.event),
        ackAll(status: DeliveryStatus = 'delivered') {
          for (const item of taken) item.event.metadata.finalizers.finish(status);
        },
      };
    },

    close(): Promise<void> {
      if (!closed) {
        closed = true;
        wakeAll(writerWaiters);
        wakeAll(readerWaiters);
      }
      return Promise.resolve();
    },
  };

  return { writer, reader };
}
