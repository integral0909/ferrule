import { describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent } from '@ferrule/core';
import { ManualClock, TapHub } from '@ferrule/runtime';

function log(message: string): LogEvent {
  return LogEvent.fromMessage(message);
}

async function collect(iterable: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
}

describe('TapHub', () => {
  it('never holds up acknowledgements of the events it observes', async () => {
    const hub = new TapHub(new ManualClock());
    const sub = hub.subscribe({ componentId: 'src' });
    const batch = new BatchNotifier();
    const original = log('acked');
    original.metadata.finalizers.add(batch.createFinalizer());
    batch.seal();
    hub.publish('src', '_default', [original]);
    const [received] = await collect(sub, 1);
    expect((received as LogEvent).metadata.finalizers.isEmpty).toBe(true);
    original.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('delivers clones, never the original event, to subscribers', async () => {
    const hub = new TapHub(new ManualClock());
    const sub = hub.subscribe({ componentId: 'src' });
    const original = log('hello');
    hub.publish('src', '_default', [original]);
    const [received] = await collect(sub, 1);
    expect(received).not.toBe(original);
    expect((received as LogEvent).get('message')).toBe('hello');
  });

  it('mutating a delivered clone never affects the pipeline event', async () => {
    const hub = new TapHub(new ManualClock());
    const sub = hub.subscribe({ componentId: 'src' });
    const original = log('hello');
    hub.publish('src', '_default', [original]);
    const [received] = await collect(sub, 1);
    (received as LogEvent).set('message', 'tampered');
    expect(original.get('message')).toBe('hello');
  });

  it('only delivers to subscribers of the matching component and port', async () => {
    const hub = new TapHub(new ManualClock());
    const sub = hub.subscribe({ componentId: 'src', port: 'errors' });
    hub.publish('src', '_default', [log('default port')]);
    hub.publish('other', 'errors', [log('other component')]);
    hub.publish('src', 'errors', [log('matched')]);
    const [received] = await collect(sub, 1);
    expect((received as LogEvent).get('message')).toBe('matched');
  });

  it('publish is a no-op with no subscribers (hasSubscribers reports this cheaply)', () => {
    const hub = new TapHub(new ManualClock());
    expect(hub.hasSubscribers('src', '_default')).toBe(false);
    expect(() => hub.publish('src', '_default', [log('x')])).not.toThrow();
  });

  it('sampling drops a fraction of events deterministically with an injected random source', () => {
    const hub = new TapHub(new ManualClock());
    const values = [0.1, 0.9, 0.1, 0.9];
    let i = 0;
    const sub = hub.subscribe(
      { componentId: 'src' },
      { sampleRate: 0.5, random: () => values[i++ % values.length]! },
    );
    for (let n = 0; n < 4; n++) hub.publish('src', '_default', [log(`m${n}`)]);
    sub.close();
    const stats = sub.stats();
    expect(stats.delivered).toBe(2);
    expect(stats.sampledOut).toBe(2);
  });

  it('rate limiting drops events beyond the configured maximum per second', () => {
    const clock = new ManualClock();
    const hub = new TapHub(clock);
    const sub = hub.subscribe({ componentId: 'src' }, { maxEventsPerSecond: 2 });
    for (let n = 0; n < 5; n++) hub.publish('src', '_default', [log(`m${n}`)]);
    const stats = sub.stats();
    expect(stats.delivered).toBe(2);
    expect(stats.rateLimited).toBe(3);
  });

  it('rate limiting refills over time', async () => {
    const clock = new ManualClock();
    const hub = new TapHub(clock);
    const sub = hub.subscribe({ componentId: 'src' }, { maxEventsPerSecond: 1 });
    hub.publish('src', '_default', [log('a')]);
    hub.publish('src', '_default', [log('b')]);
    await clock.advance(1_000);
    hub.publish('src', '_default', [log('c')]);
    expect(sub.stats().delivered).toBe(2);
  });

  it('a full queue drops the oldest buffered event, never blocking the publisher', () => {
    const hub = new TapHub(new ManualClock());
    const sub = hub.subscribe({ componentId: 'src' }, { queueCapacity: 2 });
    hub.publish('src', '_default', [log('a'), log('b'), log('c')]);
    expect(sub.stats().delivered).toBe(3);
    expect(sub.stats().queueDropped).toBe(1);
  });

  it('close() ends the async iterator and stops future delivery', async () => {
    const hub = new TapHub(new ManualClock());
    const sub = hub.subscribe({ componentId: 'src' });
    sub.close();
    const items = await collect(sub, 999);
    expect(items).toEqual([]);
    expect(hub.hasSubscribers('src', '_default')).toBe(false);
  });

  it('closeAll() closes every subscription', async () => {
    const hub = new TapHub(new ManualClock());
    const a = hub.subscribe({ componentId: 'a' });
    const b = hub.subscribe({ componentId: 'b' });
    hub.closeAll();
    expect(await collect(a, 999)).toEqual([]);
    expect(await collect(b, 999)).toEqual([]);
  });

  it('several subscribers on the same target each get their own clone', async () => {
    const hub = new TapHub(new ManualClock());
    const a = hub.subscribe({ componentId: 'src' });
    const b = hub.subscribe({ componentId: 'src' });
    const original = log('shared');
    hub.publish('src', '_default', [original]);
    const [ra] = await collect(a, 1);
    const [rb] = await collect(b, 1);
    expect(ra).not.toBe(rb);
    expect(ra).not.toBe(original);
  });
});
