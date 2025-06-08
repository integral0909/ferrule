import { describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type Event } from '@ferrule/core';
import {
  FixedConcurrencyLimiter,
  RetryPolicy,
  SinkError,
  createTestSinkContext,
  runBatchedSink,
} from '@ferrule/runtime';

function eventWithBatch(message: string): { event: LogEvent; batch: BatchNotifier } {
  const batch = new BatchNotifier();
  const event = LogEvent.fromMessage(message);
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return { event, batch };
}

describe('runBatchedSink', () => {
  it('delivers events and finishes their finalizers as delivered on success', async () => {
    const harness = createTestSinkContext();
    const sent: Event[][] = [];
    const p = runBatchedSink(harness.ctx, {
      send: (payload) => {
        sent.push(payload);
        return Promise.resolve();
      },
    });
    const { event, batch } = eventWithBatch('hi');
    await harness.feed([event]);
    harness.close();
    await p;
    expect(sent).toEqual([[event]]);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('retries a retryable failure and eventually delivers', async () => {
    const harness = createTestSinkContext();
    let calls = 0;
    const p = runBatchedSink(harness.ctx, {
      retry: new RetryPolicy({ initialDelayMs: 10, random: () => 0 }),
      send: () => {
        calls++;
        if (calls < 3) return Promise.reject(SinkError.retryable('E_TEMP', 'try again'));
        return Promise.resolve();
      },
    });
    const { event, batch } = eventWithBatch('x');
    await harness.feed([event]);
    harness.close();
    await p;
    expect(calls).toBe(3);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('finishes as errored once retries are exhausted', async () => {
    const harness = createTestSinkContext();
    let calls = 0;
    const p = runBatchedSink(harness.ctx, {
      retry: new RetryPolicy({ initialDelayMs: 1, random: () => 0, maxAttempts: 2 }),
      send: () => {
        calls++;
        return Promise.reject(SinkError.retryable('E_TEMP', 'nope'));
      },
    });
    const { event, batch } = eventWithBatch('x');
    await harness.feed([event]);
    harness.close();
    await p;
    expect(calls).toBe(2);
    await expect(batch.completion).resolves.toBe('errored');
  });

  it('finishes as rejected immediately for a permanent failure, without retrying', async () => {
    const harness = createTestSinkContext();
    let calls = 0;
    const p = runBatchedSink(harness.ctx, {
      retry: new RetryPolicy({ initialDelayMs: 100_000, random: () => 1 }),
      send: () => {
        calls++;
        return Promise.reject(SinkError.permanent('E_BAD', 'nope'));
      },
    });
    const { event, batch } = eventWithBatch('x');
    await harness.feed([event]);
    harness.close();
    await p;
    expect(calls).toBe(1);
    await expect(batch.completion).resolves.toBe('rejected');
  });

  it('treats a plain thrown error as retryable by default', async () => {
    const harness = createTestSinkContext();
    const p = runBatchedSink(harness.ctx, {
      retry: new RetryPolicy({ initialDelayMs: 1, random: () => 0, maxAttempts: 1 }),
      send: () => Promise.reject(new Error('boom')),
    });
    const { event, batch } = eventWithBatch('x');
    await harness.feed([event]);
    harness.close();
    await p;
    await expect(batch.completion).resolves.toBe('errored');
  });

  it('encodes batches before sending and groups by partition key', async () => {
    const harness = createTestSinkContext();
    const payloads: string[] = [];
    const p = runBatchedSink(harness.ctx, {
      maxEvents: 1,
      partitionKey: (e) => (e as LogEvent).get('message') as string,
      encode: (events) => events.map((e) => (e as LogEvent).get('message') as string).join(','),
      send: (payload) => {
        payloads.push(payload);
        return Promise.resolve();
      },
    });
    const { event: a } = eventWithBatch('a');
    const { event: b } = eventWithBatch('b');
    await harness.feed([a, b]);
    harness.close();
    await p;
    expect(payloads.sort()).toEqual(['a', 'b']);
  });

  it('respects a concurrency limiter, never running two sends for the same limiter at once', async () => {
    const harness = createTestSinkContext();
    const limiter = new FixedConcurrencyLimiter(1);
    let active = 0;
    let maxActive = 0;
    const p = runBatchedSink(harness.ctx, {
      maxEvents: 1,
      concurrency: limiter,
      send: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
      },
    });
    const { event: a } = eventWithBatch('a');
    const { event: b } = eventWithBatch('b');
    await harness.feed([a, b]);
    harness.close();
    await p;
    expect(maxActive).toBe(1);
  });

  it('resolves once ctx.input ends and every in-flight batch has finished', async () => {
    const harness = createTestSinkContext();
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const p = runBatchedSink(harness.ctx, {
      send: () => sendGate,
    });
    const { event } = eventWithBatch('x');
    await harness.feed([event]);
    harness.close();

    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveSend();
    await p;
    expect(settled).toBe(true);
  });
});
