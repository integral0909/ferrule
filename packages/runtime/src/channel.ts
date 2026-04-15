import type { Event } from '@ferrule/core';
import { ChannelClosedError, isAbortError } from './errors.js';

/** Capacity limits for a {@link EventChannel}. Either limit may be omitted (unbounded). */
export interface ChannelCapacity {
  /** Maximum number of buffered events. */
  events?: number;
  /** Maximum total estimated bytes of buffered events. */
  bytes?: number;
}

/** What a channel does when it is full and `whenFull` is not `block`. */
export type WhenFull = 'block' | 'drop_newest';

export interface ChannelStats {
  readonly events: number;
  readonly bytes: number;
  readonly droppedEvents: number;
  readonly droppedBytes: number;
  readonly waitingSenders: number;
  readonly waitingReceivers: number;
  readonly closed: boolean;
}

interface PendingSend {
  readonly events: Event[];
  readonly bytes: number;
  /** Admits this send's events and resolves its promise. Called by the channel only. */
  admit(): void;
  /** Fails this send's promise with `reason` (channel closed, aborted). */
  fail(reason: unknown): void;
}

interface PendingReceive {
  readonly maxEvents: number;
  readonly maxBytes: number;
  /** Resolves this receive's promise with `batch` (or `undefined` when closed and empty). */
  deliver(batch: Event[] | undefined): void;
  fail(reason: unknown): void;
}

function totalBytes(events: readonly Event[]): number {
  let bytes = 0;
  for (const e of events) bytes += e.estimatedSize();
  return bytes;
}

/**
 * A bounded, in-memory FIFO of events connecting one consumer (the reader) to one or more
 * producers (senders). Capacity is enforced in both event count and estimated bytes, whichever is
 * hit first. Multiple concurrent senders are served first-come-first-served: a sender that
 * arrives first is admitted before a later one even if the later one's smaller batch would
 * otherwise fit first ("fairness"). A single batch larger than the channel's entire capacity is
 * still admitted once the channel is empty, so an oversized batch cannot deadlock the channel.
 */
export class EventChannel {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly whenFull: WhenFull;
  private readonly queue: Event[] = [];
  private eventCount = 0;
  private byteCount = 0;
  private droppedEvents = 0;
  private droppedBytes = 0;
  private closed = false;
  private readonly pendingSends: PendingSend[] = [];
  private readonly pendingReceives: PendingReceive[] = [];
  private readonly spaceWaiters = new Set<() => void>();
  private readonly sendsSettledWaiters = new Set<() => void>();

  constructor(
    readonly id: string,
    capacity: ChannelCapacity = {},
    whenFull: WhenFull = 'block',
  ) {
    this.maxEvents = capacity.events ?? Infinity;
    this.maxBytes = capacity.bytes ?? Infinity;
    this.whenFull = whenFull;
  }

  get stats(): ChannelStats {
    return {
      events: this.eventCount,
      bytes: this.byteCount,
      droppedEvents: this.droppedEvents,
      droppedBytes: this.droppedBytes,
      waitingSenders: this.pendingSends.length,
      waitingReceivers: this.pendingReceives.length,
      closed: this.closed,
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether a batch of this size fits without exceeding capacity, or the channel is empty. */
  private fits(events: number, bytes: number): boolean {
    if (this.eventCount === 0) return true;
    return this.eventCount + events <= this.maxEvents && this.byteCount + bytes <= this.maxBytes;
  }

  /** Rough capacity check (ignoring the size of whatever might be sent next). */
  hasSpace(): boolean {
    return this.eventCount < this.maxEvents && this.byteCount < this.maxBytes;
  }

  /** Resolves once {@link hasSpace} becomes true, or the channel closes, or `signal` aborts. */
  waitForSpace(signal?: AbortSignal): Promise<void> {
    if (this.hasSpace() || this.closed) return Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
    if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!this.hasSpace() && !this.closed) return;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(signal!.reason as unknown);
      };
      const cleanup = (): void => {
        this.spaceWaiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
      };
      this.spaceWaiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notifySpaceWaiters(): void {
    for (const waiter of [...this.spaceWaiters]) waiter();
  }

  /**
   * Resolves once no {@link send} call is currently waiting for capacity on this channel
   * (immediately if none currently are). Hot reload uses this to let sends already in flight
   * against a retiring inbox be admitted normally — the retiring component is still running and
   * draining it — instead of closing the channel out from under them, which would reject an
   * unrelated upstream producer's `send` with {@link ChannelClosedError}.
   */
  waitForSendsSettled(): Promise<void> {
    if (this.pendingSends.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.sendsSettledWaiters.add(resolve);
    });
  }

  private notifySendsSettled(): void {
    if (this.pendingSends.length !== 0) return;
    const waiters = [...this.sendsSettledWaiters];
    this.sendsSettledWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  /**
   * Sends events, waiting for capacity if the channel is full (`whenFull: 'block'`, the default)
   * or dropping the whole batch if it does not fit (`whenFull: 'drop_newest'`). Resolves `true`
   * once the events are enqueued, or `false` if they were dropped instead (only possible in
   * `drop_newest` mode); callers that care about delivery guarantees must finalize dropped
   * events themselves, since the channel has no notion of finalizers. Rejects with
   * {@link ChannelClosedError} if the channel is closed, or with the abort reason if `signal`
   * aborts first.
   */
  async send(events: readonly Event[], signal?: AbortSignal): Promise<boolean> {
    if (events.length === 0) return true;
    if (this.closed) throw new ChannelClosedError(this.id);
    if (signal?.aborted === true) throw signal.reason as unknown;

    const bytes = totalBytes(events);
    if (this.pendingSends.length === 0 && this.fits(events.length, bytes)) {
      this.admit(events, bytes);
      return true;
    }
    if (this.whenFull === 'drop_newest') {
      this.droppedEvents += events.length;
      this.droppedBytes += bytes;
      return false;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      const entry: PendingSend = {
        events: [...events],
        bytes,
        admit: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        },
        fail: (reason) => {
          if (settled) return;
          settled = true;
          cleanup();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's reason as-is
          reject(reason);
        },
      };
      const onAbort = (): void => {
        const index = this.pendingSends.indexOf(entry);
        if (index !== -1) this.pendingSends.splice(index, 1);
        entry.fail(signal!.reason as unknown);
        this.notifySendsSettled();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingSends.push(entry);
    });
    return true;
  }

  /**
   * Enqueues events without waiting for capacity, even past the nominal limit. Used by transform
   * pushes, which the component contract requires to never block; backpressure for transforms is
   * applied between batches via {@link waitForSpace} instead.
   */
  pushSync(events: readonly Event[]): void {
    if (events.length === 0) return;
    if (this.closed) throw new ChannelClosedError(this.id);
    this.admit(events, totalBytes(events));
  }

  private admit(events: readonly Event[], bytes: number): void {
    for (const e of events) this.queue.push(e);
    this.eventCount += events.length;
    this.byteCount += bytes;
    this.wakeReceivers();
  }

  private pumpSends(): void {
    while (this.pendingSends.length > 0) {
      const next = this.pendingSends[0]!;
      if (!this.fits(next.events.length, next.bytes)) break;
      this.pendingSends.shift();
      this.admit(next.events, next.bytes);
      next.admit();
    }
    this.notifySpaceWaiters();
    this.notifySendsSettled();
  }

  private takeBatch(maxEvents: number, maxBytes: number): Event[] {
    const batch: Event[] = [];
    let bytes = 0;
    while (this.queue.length > 0 && batch.length < maxEvents) {
      const head = this.queue[0]!;
      const headBytes = head.estimatedSize();
      if (batch.length > 0 && bytes + headBytes > maxBytes) break;
      batch.push(this.queue.shift()!);
      bytes += headBytes;
    }
    this.eventCount -= batch.length;
    this.byteCount -= bytes;
    return batch;
  }

  private wakeReceivers(): void {
    while (this.pendingReceives.length > 0 && this.queue.length > 0) {
      const receiver = this.pendingReceives.shift()!;
      receiver.deliver(this.takeBatch(receiver.maxEvents, receiver.maxBytes));
    }
    this.pumpSends();
  }

  /**
   * Receives up to `maxEvents`/`maxBytes` buffered events (both default unbounded), waiting if
   * none are currently available. Resolves `undefined` once the channel is closed and fully
   * drained. Rejects with the abort reason if `signal` aborts first.
   */
  async receiveBatch(
    limits: { maxEvents?: number; maxBytes?: number } = {},
    signal?: AbortSignal,
  ): Promise<Event[] | undefined> {
    const maxEvents = limits.maxEvents ?? Infinity;
    const maxBytes = limits.maxBytes ?? Infinity;
    if (signal?.aborted === true) throw signal.reason as unknown;
    if (this.queue.length > 0) {
      const batch = this.takeBatch(maxEvents, maxBytes);
      this.pumpSends();
      return batch;
    }
    if (this.closed) return undefined;

    return new Promise<Event[] | undefined>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      const entry: PendingReceive = {
        maxEvents,
        maxBytes,
        deliver: (batch) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(batch);
        },
        fail: (reason) => {
          if (settled) return;
          settled = true;
          cleanup();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's reason as-is
          reject(reason);
        },
      };
      const onAbort = (): void => {
        const index = this.pendingReceives.indexOf(entry);
        if (index !== -1) this.pendingReceives.splice(index, 1);
        entry.fail(signal!.reason as unknown);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingReceives.push(entry);
    });
  }

  /** Drives a sink's input: yields batches until the channel is closed and drained. */
  async *[Symbol.asyncIterator](): AsyncIterator<Event[]> {
    for (;;) {
      const batch = await this.receiveBatch();
      if (batch === undefined) return;
      if (batch.length > 0) yield batch;
    }
  }

  /**
   * Stops accepting new sends (further {@link send} and {@link pushSync} calls throw). Buffered
   * events remain readable via {@link receiveBatch} until drained, after which it resolves
   * `undefined`. Any senders currently waiting for capacity are rejected.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pendingSends]) pending.fail(new ChannelClosedError(this.id));
    this.pendingSends.length = 0;
    if (this.queue.length === 0) {
      for (const receiver of [...this.pendingReceives]) receiver.deliver(undefined);
      this.pendingReceives.length = 0;
    }
    this.notifySpaceWaiters();
    this.notifySendsSettled();
  }

  /**
   * Forcibly empties the channel, closing it and returning every event that was buffered or
   * waiting to be admitted (admitting and immediately resolving pending senders so their `send`
   * calls do not hang). Used to force-finalize in-flight events when a shutdown deadline is
   * exceeded.
   */
  drain(): Event[] {
    const drained = [...this.queue];
    this.queue.length = 0;
    this.eventCount = 0;
    this.byteCount = 0;
    for (const pending of [...this.pendingSends]) {
      drained.push(...pending.events);
      pending.admit();
    }
    this.pendingSends.length = 0;
    this.close();
    return drained;
  }
}

/**
 * Splits `events` into `consumerCount` batches for fan-out: the first consumer receives the
 * original event objects, and every subsequent consumer receives a clone of each event (which
 * clones its finalizers too), so all consumers must acknowledge before the source's batch
 * completes and mutating one consumer's copy never affects another's.
 */
export function distributeFanOut(events: readonly Event[], consumerCount: number): Event[][] {
  if (consumerCount <= 0) return [];
  const out: Event[][] = [events.slice()];
  for (let i = 1; i < consumerCount; i++) out.push(events.map((e) => e.clone()));
  return out;
}

export { isAbortError };
