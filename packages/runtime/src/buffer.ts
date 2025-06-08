import type { Event } from '@ferrule/core';
import type { Clock, Logger } from './component.js';
import { type ChannelCapacity, EventChannel } from './channel.js';

export interface EventBufferStats {
  readonly events: number;
  readonly bytes: number;
}

/** The writing half of an {@link EventBuffer}, used by the pipeline to enqueue events for a sink. */
export interface EventBufferWriter {
  /** Writes events, awaiting backpressure if the buffer is full. */
  write(events: readonly Event[], signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** The reading half of an {@link EventBuffer}, used to feed a sink's input. */
export interface EventBufferReader {
  /** Reads up to `max` events, waiting if none are available. `undefined` once closed and drained. */
  read(max: number, signal?: AbortSignal): Promise<Event[] | undefined>;
  close(): Promise<void>;
}

/**
 * A durable (or, in the in-memory case, best-effort) holding area for events awaiting delivery by
 * a sink. A disk-backed implementation (see `@ferrule/buffer`, built separately) can be plugged in
 * through {@link EventBufferFactory} without the runtime depending on it directly.
 */
export interface EventBuffer {
  readonly writer: EventBufferWriter;
  readonly reader: EventBufferReader;
  stats(): EventBufferStats;
  close(): Promise<void>;
}

/** Context handed to an {@link EventBufferFactory} when it builds a buffer for one sink. */
export interface EventBufferFactoryContext {
  readonly componentId: string;
  readonly dataDir: string | undefined;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Builds an {@link EventBuffer} for a sink configured with `buffer: { type: disk, ... }`. The
 * runtime never imports a disk implementation itself; a host application supplies one (for
 * example an adapter around `@ferrule/buffer`) via {@link PipelineOptions.bufferFactory}.
 */
export type EventBufferFactory = (
  options: Readonly<Record<string, unknown>>,
  ctx: EventBufferFactoryContext,
) => EventBuffer | Promise<EventBuffer>;

/**
 * An in-memory {@link EventBuffer}. Not crash-safe: buffered events are lost on process exit.
 * Used for `buffer: { type: memory }` (the default) and as the fallback when no
 * {@link EventBufferFactory} is configured.
 */
export class MemoryEventBuffer implements EventBuffer {
  private readonly channel: EventChannel;
  readonly writer: EventBufferWriter;
  readonly reader: EventBufferReader;

  constructor(id: string, capacity: ChannelCapacity = {}) {
    this.channel = new EventChannel(id, capacity, 'block');
    this.writer = {
      // The channel is always 'block' mode here, so send() never actually drops.
      write: (events, signal) => this.channel.send(events, signal).then(() => undefined),
      close: () => {
        this.channel.close();
        return Promise.resolve();
      },
    };
    this.reader = {
      read: (max, signal) => this.channel.receiveBatch({ maxEvents: max }, signal),
      close: () => {
        this.channel.close();
        return Promise.resolve();
      },
    };
  }

  stats(): EventBufferStats {
    const s = this.channel.stats;
    return { events: s.events, bytes: s.bytes };
  }

  close(): Promise<void> {
    this.channel.close();
    return Promise.resolve();
  }
}

/** Default {@link EventBufferFactory} equivalent used when a sink asks for `type: memory`. */
export function createMemoryEventBuffer(id: string, capacity: ChannelCapacity = {}): EventBuffer {
  return new MemoryEventBuffer(id, capacity);
}
