import { FerruleError } from '@ferrule/core';
import type { Clock } from '../component.js';
import { SystemClock } from '../clock.js';

export interface BatcherOptions<T> {
  /** Flush a partition once it reaches this many items. Default unbounded. */
  readonly maxEvents?: number;
  /** Flush a partition once {@link sizeOf} totals this many bytes. Default unbounded. */
  readonly maxBytes?: number;
  /** Flush a partition this long after its first item arrived, regardless of size. Default: never. */
  readonly timeoutMs?: number;
  /** Size of one item in bytes, for {@link maxBytes}. Default: every item counts as 0 bytes. */
  readonly sizeOf?: (item: T) => number;
  /** Groups items into independent batches. Default: a single partition. */
  readonly partitionKey?: (item: T) => string;
  readonly clock?: Clock;
  /** Called synchronously whenever a partition is flushed (by size, by timeout, or explicitly). */
  readonly onFlush: (partitionKey: string, items: T[]) => void;
}

interface PartitionState<T> {
  items: T[];
  bytes: number;
  timer: AbortController | undefined;
}

/**
 * Groups items into batches bounded by count, estimated size, and time, optionally partitioned
 * by a key function (each partition batches independently). No item is ever lost or duplicated:
 * every item passed to {@link add} is eventually delivered to {@link BatcherOptions.onFlush}
 * exactly once, either because a limit was hit or because {@link close} (or {@link flush}) was
 * called.
 */
export class Batcher<T> {
  private readonly partitions = new Map<string, PartitionState<T>>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number | undefined;
  private readonly sizeOf: (item: T) => number;
  private readonly partitionKey: (item: T) => string;
  private readonly clock: Clock;
  private readonly onFlush: (partitionKey: string, items: T[]) => void;
  private closed = false;

  constructor(options: BatcherOptions<T>) {
    this.maxEvents = options.maxEvents ?? Infinity;
    this.maxBytes = options.maxBytes ?? Infinity;
    this.timeoutMs = options.timeoutMs;
    this.sizeOf = options.sizeOf ?? (() => 0);
    this.partitionKey = options.partitionKey ?? (() => '');
    this.clock = options.clock ?? new SystemClock();
    this.onFlush = options.onFlush;
  }

  /** Adds one item, flushing its partition immediately if this pushes it over a limit. */
  add(item: T): void {
    if (this.closed) throw new FerruleError('E_BATCHER_CLOSED', 'batcher is closed');
    const key = this.partitionKey(item);
    let state = this.partitions.get(key);
    if (state === undefined) {
      state = { items: [], bytes: 0, timer: undefined };
      this.partitions.set(key, state);
      this.scheduleTimeout(key);
    }
    state.items.push(item);
    state.bytes += this.sizeOf(item);
    if (state.items.length >= this.maxEvents || state.bytes >= this.maxBytes) {
      this.flushPartition(key);
    }
  }

  private scheduleTimeout(key: string): void {
    if (this.timeoutMs === undefined) return;
    const controller = new AbortController();
    const state = this.partitions.get(key);
    if (state === undefined) return;
    state.timer = controller;
    this.clock
      .sleep(this.timeoutMs, controller.signal)
      .then(() => this.flushPartition(key))
      .catch(() => undefined);
  }

  /** Flushes one partition (or, with no argument, every partition) that currently has items. */
  flush(key?: string): void {
    if (key !== undefined) {
      this.flushPartition(key);
      return;
    }
    for (const k of [...this.partitions.keys()]) this.flushPartition(k);
  }

  private flushPartition(key: string): void {
    const state = this.partitions.get(key);
    if (state === undefined) return;
    this.partitions.delete(key);
    state.timer?.abort();
    if (state.items.length > 0) this.onFlush(key, state.items);
  }

  /** Flushes everything and stops accepting new items; {@link add} throws afterward. */
  close(): void {
    this.flush();
    this.closed = true;
  }

  /** Number of partitions currently holding unflushed items. */
  get pendingPartitions(): number {
    return this.partitions.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
