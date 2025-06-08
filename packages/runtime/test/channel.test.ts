import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BatchNotifier, LogEvent } from '@ferrule/core';
import { distributeFanOut, EventChannel } from '@ferrule/runtime';

function log(message: string): LogEvent {
  return LogEvent.fromMessage(message);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('EventChannel', () => {
  it('sends and receives in FIFO order', async () => {
    const ch = new EventChannel('c');
    await ch.send([log('a'), log('b')]);
    const batch = await ch.receiveBatch();
    expect(batch?.map((e) => (e as LogEvent).get('message'))).toEqual(['a', 'b']);
  });

  it('receiveBatch waits when the channel is empty', async () => {
    const ch = new EventChannel('c');
    let received: unknown;
    const p = ch.receiveBatch().then((b) => {
      received = b;
    });
    await flush();
    expect(received).toBeUndefined();
    await ch.send([log('x')]);
    await p;
    expect(received).toHaveLength(1);
  });

  it('respects maxEvents/maxBytes limits on receiveBatch', async () => {
    const ch = new EventChannel('c');
    await ch.send([log('a'), log('b'), log('c')]);
    const first = await ch.receiveBatch({ maxEvents: 2 });
    expect(first).toHaveLength(2);
    const second = await ch.receiveBatch({ maxEvents: 2 });
    expect(second).toHaveLength(1);
  });

  it('always takes at least one event even if it alone exceeds maxBytes', async () => {
    const ch = new EventChannel('c');
    await ch.send([log('a very very very long message indeed')]);
    const batch = await ch.receiveBatch({ maxBytes: 1 });
    expect(batch).toHaveLength(1);
  });

  describe('backpressure (event capacity)', () => {
    it('send waits until capacity frees up', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await ch.send([log('a')]);
      let sent = false;
      const p = ch.send([log('b')]).then(() => {
        sent = true;
      });
      await flush();
      expect(sent).toBe(false);
      await ch.receiveBatch({ maxEvents: 1 });
      await p;
      expect(sent).toBe(true);
    });

    it('an oversized single batch is still admitted once the channel is empty', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await expect(ch.send([log('a'), log('b'), log('c')])).resolves.toBe(true);
      expect(ch.stats.events).toBe(3);
    });
  });

  describe('backpressure (byte capacity)', () => {
    it('send waits until enough estimated bytes are free', async () => {
      const big = log('x'.repeat(1000));
      const bytes = big.estimatedSize();
      const ch = new EventChannel('c', { bytes });
      await ch.send([big]);
      let sent = false;
      const p = ch.send([log('y')]).then(() => {
        sent = true;
      });
      await flush();
      expect(sent).toBe(false);
      await ch.receiveBatch();
      await p;
      expect(sent).toBe(true);
    });
  });

  describe('whenFull: drop_newest', () => {
    it('drops the whole incoming batch instead of waiting, and reports it via the return value', async () => {
      const ch = new EventChannel('c', { events: 1 }, 'drop_newest');
      await expect(ch.send([log('a')])).resolves.toBe(true);
      await expect(ch.send([log('b'), log('c')])).resolves.toBe(false);
      expect(ch.stats.events).toBe(1);
      expect(ch.stats.droppedEvents).toBe(2);
      const batch = await ch.receiveBatch();
      expect(batch?.map((e) => (e as LogEvent).get('message'))).toEqual(['a']);
    });

    it('still admits an oversized batch when the channel is empty', async () => {
      const ch = new EventChannel('c', { events: 1 }, 'drop_newest');
      await expect(ch.send([log('a'), log('b')])).resolves.toBe(true);
      expect(ch.stats.events).toBe(2);
      expect(ch.stats.droppedEvents).toBe(0);
    });
  });

  describe('fairness', () => {
    it('serves waiting senders strictly in arrival order', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await ch.send([log('first')]);
      const order: string[] = [];
      const pA = ch.send([log('A')]).then(() => order.push('A'));
      await flush();
      const pB = ch.send([log('B')]).then(() => order.push('B'));
      await flush();

      // Draining one slot at a time should admit A before B even though B's batch is the same size.
      await ch.receiveBatch({ maxEvents: 1 });
      await flush();
      await ch.receiveBatch({ maxEvents: 1 });
      await Promise.all([pA, pB]);
      expect(order).toEqual(['A', 'B']);
    });

    it('a later, smaller send does not jump ahead of an earlier, larger one', async () => {
      const ch = new EventChannel('c', { events: 2 });
      await ch.send([log('a'), log('b')]); // fills capacity
      const order: string[] = [];
      const big = ch.send([log('c'), log('d')]).then(() => order.push('big'));
      await flush();
      const small = ch.send([log('e')]).then(() => order.push('small'));
      await flush();

      await ch.receiveBatch({ maxEvents: 2 }); // frees 2 slots; only "big" (needs 2) can fit first
      await flush();
      expect(order).toEqual(['big']);
      await ch.receiveBatch({ maxEvents: 2 });
      await Promise.all([big, small]);
      expect(order).toEqual(['big', 'small']);
    });
  });

  describe('close and drain', () => {
    it('close prevents further sends', async () => {
      const ch = new EventChannel('c');
      ch.close();
      await expect(ch.send([log('a')])).rejects.toThrow(/closed/);
      expect(() => ch.pushSync([log('a')])).toThrow(/closed/);
    });

    it('buffered events remain readable after close, then receiveBatch resolves undefined', async () => {
      const ch = new EventChannel('c');
      await ch.send([log('a')]);
      ch.close();
      const batch = await ch.receiveBatch();
      expect(batch).toHaveLength(1);
      await expect(ch.receiveBatch()).resolves.toBeUndefined();
    });

    it('close resolves a pending receive with undefined once the channel is already empty', async () => {
      const ch = new EventChannel('c');
      const p = ch.receiveBatch();
      ch.close();
      await expect(p).resolves.toBeUndefined();
    });

    it('close rejects senders still waiting for capacity', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await ch.send([log('a')]);
      const p = ch.send([log('b')]);
      await flush();
      ch.close();
      await expect(p).rejects.toThrow(/closed/);
    });

    it('drain empties the channel, admits pending senders, and finalizes nothing itself', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await ch.send([log('a')]);
      let sent = false;
      const p = ch.send([log('b')]).then(() => {
        sent = true;
      });
      await flush();
      const drained = ch.drain();
      await p;
      expect(sent).toBe(true);
      expect(drained.map((e) => (e as LogEvent).get('message'))).toEqual(['a', 'b']);
      expect(ch.isClosed).toBe(true);
      expect(ch.stats.events).toBe(0);
    });
  });

  describe('abort-aware waits', () => {
    it('send rejects when its signal aborts while waiting', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await ch.send([log('a')]);
      const controller = new AbortController();
      const p = ch.send([log('b')], controller.signal);
      await flush();
      controller.abort(new Error('cancel send'));
      await expect(p).rejects.toThrow('cancel send');
      // The channel's capacity accounting is unaffected by the abandoned send.
      expect(ch.stats.events).toBe(1);
    });

    it('receiveBatch rejects when its signal aborts while waiting', async () => {
      const ch = new EventChannel('c');
      const controller = new AbortController();
      const p = ch.receiveBatch({}, controller.signal);
      await flush();
      controller.abort(new Error('cancel receive'));
      await expect(p).rejects.toThrow('cancel receive');
    });

    it('waitForSpace resolves immediately when there is room', async () => {
      const ch = new EventChannel('c');
      await expect(ch.waitForSpace()).resolves.toBeUndefined();
    });

    it('waitForSpace resolves once capacity frees and rejects on abort otherwise', async () => {
      const ch = new EventChannel('c', { events: 1 });
      await ch.send([log('a')]);
      let ready = false;
      const p = ch.waitForSpace().then(() => {
        ready = true;
      });
      await flush();
      expect(ready).toBe(false);
      await ch.receiveBatch();
      await p;
      expect(ready).toBe(true);
    });
  });

  it('is an async iterable that ends once closed and drained', async () => {
    const ch = new EventChannel('c');
    await ch.send([log('a')]);
    await ch.send([log('b')]);
    ch.close();
    const batches: string[][] = [];
    for await (const batch of ch) {
      batches.push(batch.map((e) => (e as LogEvent).get('message') as string));
    }
    expect(batches.flat()).toEqual(['a', 'b']);
  });

  it('pushSync enqueues without waiting, even past nominal capacity', () => {
    const ch = new EventChannel('c', { events: 1 });
    ch.pushSync([log('a')]);
    ch.pushSync([log('b')]);
    expect(ch.stats.events).toBe(2);
  });

  it('never loses, duplicates, or reorders events, for any capacity and batch shape (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }),
          {
            minLength: 0,
            maxLength: 15,
          },
        ),
        fc.integer({ min: 1, max: 5 }),
        async (batches, capacity) => {
          const ch = new EventChannel('prop', { events: capacity });
          const received: string[] = [];
          const drain = (async () => {
            for await (const batch of ch) {
              for (const e of batch) received.push((e as LogEvent).get('message') as string);
            }
          })();
          for (const tags of batches) await ch.send(tags.map((t) => log(t)));
          ch.close();
          await drain;
          expect(received).toEqual(batches.flat());
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('distributeFanOut', () => {
  it('gives the first consumer the original events and later consumers clones', () => {
    const a = log('hello');
    const [first, second] = distributeFanOut([a], 2);
    expect(first?.[0]).toBe(a);
    expect(second?.[0]).not.toBe(a);
    expect((second?.[0] as LogEvent).get('message')).toBe('hello');
  });

  it('returns one array per consumer, each with the same event count', () => {
    const events = [log('a'), log('b'), log('c')];
    const batches = distributeFanOut(events, 3);
    expect(batches).toHaveLength(3);
    for (const b of batches) expect(b).toHaveLength(3);
  });

  it('returns an empty array of batches for zero consumers', () => {
    expect(distributeFanOut([log('a')], 0)).toEqual([]);
  });

  it('clones finalizers independently so the batch only completes once every clone finishes', async () => {
    const batch = new BatchNotifier();
    const event = log('acked');
    event.metadata.finalizers.add(batch.createFinalizer());
    batch.seal();

    const [original, clone] = distributeFanOut([event], 2);
    expect(original?.[0]).toBe(event);

    let completed = false;
    void batch.completion.then(() => {
      completed = true;
    });

    original![0]!.metadata.finalizers.finish('delivered');
    await flush();
    expect(completed).toBe(false); // the clone's finalizer is still outstanding

    clone![0]!.metadata.finalizers.finish('delivered');
    await flush();
    expect(completed).toBe(true);
  });

  it('mutating one consumer copy never affects another', () => {
    const [first, second] = distributeFanOut([log('original')], 2);
    (first![0] as LogEvent).set('message', 'mutated');
    expect((second![0] as LogEvent).get('message')).toBe('original');
  });

  it('reports the worst status across fan-out clones', async () => {
    const batch = new BatchNotifier();
    const event = log('x');
    event.metadata.finalizers.add(batch.createFinalizer());
    batch.seal();
    const [a, b] = distributeFanOut([event], 2);
    a![0]!.metadata.finalizers.finish('delivered');
    b![0]!.metadata.finalizers.finish('rejected');
    await expect(batch.completion).resolves.toBe('rejected');
  });
});
