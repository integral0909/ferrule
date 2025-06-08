import type { Event } from '@ferrule/core';
import type { Clock } from './component.js';
import { DEFAULT_PORT } from './component.js';

/** What to observe: a component's default port, or one of its named ports. */
export interface TapTarget {
  readonly componentId: string;
  readonly port?: string;
}

export interface TapOptions {
  /** Fraction of events delivered, in (0, 1]. Default 1 (every event). */
  readonly sampleRate?: number;
  /** Maximum events delivered per second; the rest are dropped and counted. Default unlimited. */
  readonly maxEventsPerSecond?: number;
  /** Bound on the subscriber's queue; oldest queued events are dropped once full. Default 1000. */
  readonly queueCapacity?: number;
  /** Source of randomness for sampling. Overridable for deterministic tests. */
  readonly random?: () => number;
}

export interface TapStats {
  readonly delivered: number;
  readonly sampledOut: number;
  readonly rateLimited: number;
  readonly queueDropped: number;
}

export interface TapSubscription extends AsyncIterable<Event> {
  readonly target: TapTarget;
  stats(): TapStats;
  close(): void;
}

class TapSubscriber implements TapSubscription {
  private readonly buffer: Event[] = [];
  private waiting: ((event: Event | undefined) => void) | undefined;
  private closed = false;
  private readonly capacity: number;
  private readonly sampleRate: number;
  private readonly maxEventsPerSecond: number | undefined;
  private readonly random: () => number;
  private tokens: number;
  private lastRefillMono: number;
  private delivered = 0;
  private sampledOut = 0;
  private rateLimited = 0;
  private queueDropped = 0;

  constructor(
    readonly target: TapTarget,
    options: TapOptions,
    private readonly clock: Clock,
    private readonly onClose: (subscriber: TapSubscriber) => void,
  ) {
    this.capacity = options.queueCapacity ?? 1000;
    this.sampleRate = options.sampleRate ?? 1;
    this.maxEventsPerSecond = options.maxEventsPerSecond;
    this.random = options.random ?? Math.random;
    this.tokens = this.maxEventsPerSecond ?? Infinity;
    this.lastRefillMono = clock.monotonic();
  }

  /** Offers `event` to this subscriber. Never called with the pipeline's own event; always a clone. */
  offer(event: Event): void {
    if (this.closed) return;
    if (this.sampleRate < 1 && this.random() >= this.sampleRate) {
      this.sampledOut++;
      return;
    }
    if (this.maxEventsPerSecond !== undefined && !this.consumeToken()) {
      this.rateLimited++;
      return;
    }
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.delivered++;
      resolve(event);
      return;
    }
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
      this.queueDropped++;
    }
    this.buffer.push(event);
    this.delivered++;
  }

  private consumeToken(): boolean {
    const now = this.clock.monotonic();
    const elapsedMs = now - this.lastRefillMono;
    if (elapsedMs > 0) {
      this.lastRefillMono = now;
      this.tokens = Math.min(
        this.maxEventsPerSecond!,
        this.tokens + (elapsedMs / 1000) * this.maxEventsPerSecond!,
      );
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  stats(): TapStats {
    return {
      delivered: this.delivered,
      sampledOut: this.sampledOut,
      rateLimited: this.rateLimited,
      queueDropped: this.queueDropped,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting?.(undefined);
    this.waiting = undefined;
    this.onClose(this);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Event> {
    for (;;) {
      const head = this.buffer.shift();
      if (head !== undefined) {
        yield head;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<Event | undefined>((resolve) => {
        this.waiting = resolve;
      });
      if (next === undefined) return;
      yield next;
    }
  }
}

/**
 * Routes clones of events flowing out of tapped components to their subscribers. Delivery never
 * blocks the pipeline and never shares objects with it: {@link publish} clones lazily (only when
 * there is at least one live subscriber for the port) and a full subscriber queue drops its
 * oldest entry rather than applying backpressure.
 */
export class TapHub {
  private readonly subscribers = new Map<string, Set<TapSubscriber>>();

  constructor(private readonly clock: Clock) {}

  subscribe(target: TapTarget, options: TapOptions = {}): TapSubscription {
    const key = tapKey(target);
    const subscriber = new TapSubscriber(target, options, this.clock, (s) => this.remove(key, s));
    const set = this.subscribers.get(key) ?? new Set();
    set.add(subscriber);
    this.subscribers.set(key, set);
    return subscriber;
  }

  private remove(key: string, subscriber: TapSubscriber): void {
    const set = this.subscribers.get(key);
    set?.delete(subscriber);
    if (set !== undefined && set.size === 0) this.subscribers.delete(key);
  }

  /** True if anything is currently tapping `componentId`/`port`, to skip cloning cheaply. */
  hasSubscribers(componentId: string, port: string): boolean {
    const set = this.subscribers.get(tapKey({ componentId, port }));
    return set !== undefined && set.size > 0;
  }

  /** Publishes `events` (already flowing through `componentId`/`port`) to every subscriber. */
  publish(componentId: string, port: string, events: readonly Event[]): void {
    const set = this.subscribers.get(tapKey({ componentId, port }));
    if (set === undefined || set.size === 0) return;
    for (const subscriber of set) {
      for (const event of events) subscriber.offer(event.clone());
    }
  }

  /** Closes every subscription, for pipeline shutdown. */
  closeAll(): void {
    for (const set of this.subscribers.values()) for (const s of [...set]) s.close();
  }
}

function tapKey(target: TapTarget): string {
  return `${target.componentId}\u0000${target.port ?? DEFAULT_PORT}`;
}
