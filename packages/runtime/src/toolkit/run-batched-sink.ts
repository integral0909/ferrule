import type { DeliveryStatus, Event } from '@ferrule/core';
import type { SinkContext } from '../component.js';
import { Batcher } from './batcher.js';
import { RetryPolicy } from './retry.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import {
  AdaptiveConcurrencyLimiter,
  FixedConcurrencyLimiter,
  type ConcurrencyLimiter,
} from './concurrency.js';
import { classifySinkError } from './sink-errors.js';

export interface RunBatchedSinkOptions<Encoded = Event[]> {
  /** Flush a batch once it reaches this many events. Default unbounded. */
  readonly maxEvents?: number;
  /** Flush a batch once its estimated size reaches this many bytes. Default unbounded. */
  readonly maxBytes?: number;
  /** Flush a batch this long after its first event, regardless of size. Default: never. */
  readonly timeoutMs?: number;
  /** Groups events into independent batches (e.g. by destination table or stream). */
  readonly partitionKey?: (event: Event) => string;
  /** Converts a batch of events into whatever {@link send} expects. Default: the events as-is. */
  readonly encode?: (events: Event[]) => Encoded;
  /** Delivers one encoded batch. Throw a {@link SinkError} (or anything; see `classifySinkError`). */
  readonly send: (payload: Encoded, attempt: number) => Promise<void>;
  readonly retry?: RetryPolicy;
  readonly concurrency?: ConcurrencyLimiter;
  readonly breaker?: CircuitBreaker;
}

/**
 * Drives a sink's `run`: consumes `ctx.input`, regroups events into batches via {@link Batcher},
 * and delivers each with {@link RunBatchedSinkOptions.send}, retrying transient failures with
 * `retry` and bounding concurrency with `concurrency`. Every event's finalizers are finished with
 * `delivered` (send succeeded), `errored` (retries exhausted on a retryable failure), or
 * `rejected` (a permanent failure). Resolves once `ctx.input` ends and every in-flight batch has
 * finished.
 */
export async function runBatchedSink<Encoded = Event[]>(
  ctx: SinkContext,
  options: RunBatchedSinkOptions<Encoded>,
): Promise<void> {
  const concurrency = options.concurrency ?? new FixedConcurrencyLimiter(1);
  const inFlight = new Set<Promise<void>>();

  const batcher = new Batcher<Event>({
    ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    sizeOf: (e) => e.estimatedSize(),
    ...(options.partitionKey !== undefined ? { partitionKey: options.partitionKey } : {}),
    clock: ctx.clock,
    onFlush: (_key, events) => {
      const task = deliverBatch(ctx, events, options, concurrency);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
  });

  for await (const events of ctx.input) {
    for (const event of events) batcher.add(event);
  }
  batcher.close();
  await Promise.all(inFlight);
}

async function deliverBatch<Encoded>(
  ctx: SinkContext,
  events: Event[],
  options: RunBatchedSinkOptions<Encoded>,
  concurrency: ConcurrencyLimiter,
): Promise<void> {
  const release = await concurrency.acquire(ctx.signal).catch(() => undefined);
  if (release === undefined) {
    finishEvents(events, 'errored');
    return;
  }
  const startMono = ctx.clock.monotonic();
  try {
    const encoded =
      options.encode !== undefined ? options.encode(events) : (events as unknown as Encoded);
    const retry = options.retry ?? new RetryPolicy({ maxAttempts: 1 });
    let attempt = 0;
    for (;;) {
      attempt++;
      if (options.breaker !== undefined && !options.breaker.tryAcquire()) {
        const elapsed = ctx.clock.monotonic() - startMono;
        const decision = retry.next(attempt, elapsed);
        if (!(await waitOrGiveUp(ctx, events, decision))) return;
        continue;
      }
      try {
        await options.send(encoded, attempt);
        options.breaker?.recordSuccess();
        reportAdaptive(concurrency, true, ctx.clock.monotonic() - startMono);
        finishEvents(events, 'delivered');
        return;
      } catch (rawError) {
        options.breaker?.recordFailure();
        reportAdaptive(concurrency, false, ctx.clock.monotonic() - startMono);
        const error = classifySinkError(rawError);
        if (!error.retryable) {
          finishEvents(events, 'rejected');
          return;
        }
        const elapsed = ctx.clock.monotonic() - startMono;
        const decision = retry.next(attempt, elapsed, error.retryAfterMs);
        if (!(await waitOrGiveUp(ctx, events, decision))) return;
      }
    }
  } finally {
    release();
  }
}

async function waitOrGiveUp(
  ctx: SinkContext,
  events: readonly Event[],
  decision: { shouldRetry: boolean; delayMs: number },
): Promise<boolean> {
  if (!decision.shouldRetry) {
    finishEvents(events, 'errored');
    return false;
  }
  try {
    await ctx.clock.sleep(decision.delayMs, ctx.signal);
  } catch {
    finishEvents(events, 'errored');
    return false;
  }
  return true;
}

function reportAdaptive(
  concurrency: ConcurrencyLimiter,
  success: boolean,
  latencyMs: number,
): void {
  if (concurrency instanceof AdaptiveConcurrencyLimiter) concurrency.report({ success, latencyMs });
}

function finishEvents(events: readonly Event[], status: DeliveryStatus): void {
  for (const e of events) e.metadata.finalizers.finish(status);
}
