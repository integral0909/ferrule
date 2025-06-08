import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrencyLimiter, FixedConcurrencyLimiter } from '@ferrule/runtime';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('FixedConcurrencyLimiter', () => {
  it('admits up to the configured limit immediately', async () => {
    const limiter = new FixedConcurrencyLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.inFlight).toBe(2);
  });

  it('queues acquisitions beyond the limit until a release', async () => {
    const limiter = new FixedConcurrencyLimiter(1);
    const release1 = await limiter.acquire();
    let acquired = false;
    const p = limiter.acquire().then(() => {
      acquired = true;
    });
    await flush();
    expect(acquired).toBe(false);
    release1();
    await p;
    expect(acquired).toBe(true);
  });

  it('serves queued acquisitions in FIFO order', async () => {
    const limiter = new FixedConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const order: string[] = [];
    void limiter.acquire().then((r) => {
      order.push('a');
      r();
    });
    await flush();
    void limiter.acquire().then((r) => {
      order.push('b');
      r();
    });
    await flush();
    release();
    await flush();
    await flush();
    expect(order).toEqual(['a', 'b']);
  });

  it('an abort while waiting rejects the acquisition', async () => {
    const limiter = new FixedConcurrencyLimiter(1);
    await limiter.acquire();
    const controller = new AbortController();
    const p = limiter.acquire(controller.signal);
    await flush();
    controller.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow('cancelled');
  });

  it('releasing twice is a no-op', async () => {
    const limiter = new FixedConcurrencyLimiter(1);
    const release = await limiter.acquire();
    release();
    release();
    expect(limiter.inFlight).toBe(0);
  });
});

describe('AdaptiveConcurrencyLimiter', () => {
  it('starts at the initial limit', () => {
    const limiter = new AdaptiveConcurrencyLimiter({ initialLimit: 3 });
    expect(limiter.limit).toBe(3);
  });

  it('increases the limit after enough consecutive good completions', () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      initialLimit: 2,
      increaseAfter: 3,
      maxLimit: 10,
    });
    for (let i = 0; i < 3; i++) limiter.report({ success: true, latencyMs: 1 });
    expect(limiter.limit).toBe(3);
  });

  it('decreases multiplicatively on failure', () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      initialLimit: 8,
      decreaseFactor: 0.5,
      minLimit: 1,
    });
    limiter.report({ success: false, latencyMs: 1 });
    expect(limiter.limit).toBe(4);
  });

  it('decreases on high latency even if the call "succeeded"', () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      initialLimit: 8,
      latencyThresholdMs: 100,
      decreaseFactor: 0.5,
    });
    limiter.report({ success: true, latencyMs: 500 });
    expect(limiter.limit).toBe(4);
  });

  it('never grows past maxLimit or shrinks below minLimit', () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      initialLimit: 1,
      maxLimit: 2,
      increaseAfter: 1,
    });
    for (let i = 0; i < 10; i++) limiter.report({ success: true, latencyMs: 1 });
    expect(limiter.limit).toBe(2);

    const shrinking = new AdaptiveConcurrencyLimiter({
      initialLimit: 1,
      minLimit: 1,
      decreaseFactor: 0.1,
    });
    for (let i = 0; i < 10; i++) shrinking.report({ success: false, latencyMs: 1 });
    expect(shrinking.limit).toBe(1);
  });

  it('a growing limit admits a previously queued acquisition', async () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      initialLimit: 1,
      increaseAfter: 1,
      maxLimit: 5,
    });
    await limiter.acquire();
    let acquired = false;
    const p = limiter.acquire().then(() => {
      acquired = true;
    });
    await flush();
    expect(acquired).toBe(false);
    limiter.report({ success: true, latencyMs: 1 }); // grows the limit to 2, pumping the queue
    await p;
    expect(acquired).toBe(true);
  });
});
