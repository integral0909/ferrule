import { LogEvent, parseJson, type ValueMap } from '@ferrule/core';
import { ManualClock } from '@ferrule/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminHarness } from './fixtures.js';
import { collectLines, openRaw, readLines, readLinesUntilEnd, waitUntil } from './tap-helpers.js';

function asMap(value: unknown): ValueMap {
  if (!(value instanceof Map)) throw new Error('expected an object');
  return value as ValueMap;
}

describe('GET /tap/:component', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('streams events as newline-delimited JSON by default', async () => {
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock }, [
      { events: [LogEvent.fromMessage('hello'), LogEvent.fromMessage('world')], delayMs: 20 },
    ]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);

    // Deterministic instead of a real-timing race: don't release the scripted source's delayed
    // step until the tap subscription is actually registered server-side, so the events can
    // never fire before anything is listening for them.
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(20);

    const lines = await readLines(res, 2);
    req.destroy();

    const decoded = lines.map((line) => asMap(parseJson(line)));
    expect(decoded.map((d) => asMap(d.get('fields')!).get('message'))).toEqual(['hello', 'world']);
    expect(decoded.every((d) => d.get('kind') === 'log')).toBe(true);
  }, 15_000); // real streaming HTTP I/O; generous headroom under parallel test-suite load

  it('streams events as Server-Sent Events with ?format=sse', async () => {
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock }, [
      { events: [LogEvent.fromMessage('hi')], delayMs: 20 },
    ]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?format=sse`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // Same deterministic hand-off as the ndjson test above: hold the scripted source's delayed
    // step until the tap is registered server-side. On a real timer the event can fire before
    // anything is subscribed — the connection setup alone can outlast 20ms under parallel load —
    // and a tap only ever sees events published while it is listening, so nothing would arrive.
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(20);
    const lines = await readLines(res, 1);
    req.destroy();

    expect(lines[0]!.startsWith('data: ')).toBe(true);
    const decoded = asMap(parseJson(lines[0]!.slice('data: '.length)));
    expect(asMap(decoded.get('fields')!).get('message')).toBe('hi');
  }, 15_000);

  it('sends periodic SSE heartbeat comments, driven by the injected clock', async () => {
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock, tap: { heartbeatIntervalMs: 1000 } }, [
      { events: [LogEvent.fromMessage('first')], delayMs: 5_000 },
    ]);
    cleanup = h.stop;

    // The scripted source's own 5s sleep is pending before the tap is even opened, so a bare
    // `pendingCount >= 1` is satisfied without the heartbeat timer existing — and advancing then
    // would schedule the first heartbeat a full interval past the time we just advanced to, so it
    // would never fire. Count up from that baseline instead: the extra sleep is the heartbeat.
    const sleepsBeforeTap = clock.pendingCount;
    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?format=sse`);
    expect(res.statusCode).toBe(200);

    await waitUntil(
      () => h.server.activeTapCount() === 1 && clock.pendingCount > sleepsBeforeTap,
      10_000,
    );
    await clock.advance(1000);
    const lines = await collectLines(res, { minLines: 1, quietMs: 100 });
    req.destroy();

    expect(lines.some((l) => l.includes('heartbeat'))).toBe(true);
  }, 15_000);

  it('stops after ?limit= events', async () => {
    const events = Array.from({ length: 5 }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock }, [{ events, delayMs: 10 }]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?limit=3`);
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(10);
    // The server closes the stream once the limit is reached, so reading to the end asserts both
    // halves of this test at once — three events, and then the stream really was over — without
    // a silence window, which a stalled worker thread satisfies whether or not the server closed.
    const lines = await readLinesUntilEnd(res);
    req.destroy();
    expect(lines).toHaveLength(3);
  }, 15_000);

  it('accepts an explicit ?port= for the default port', async () => {
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock }, [
      { events: [LogEvent.fromMessage('x')], delayMs: 10 },
    ]);
    cleanup = h.stop;
    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?port=_default`);
    // Deterministic instead of a real-timing race: see the first test in this file.
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(10);
    const lines = await readLines(res, 1);
    req.destroy();
    expect(lines).toHaveLength(1);
  }, 15_000);

  it('returns 404 for an unknown component', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const { res } = await openRaw(`${h.baseUrl}/tap/does-not-exist`);
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid ?sample= with 400', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    for (const sample of ['0', '1.5', '-1', 'nope']) {
      const { res } = await openRaw(`${h.baseUrl}/tap/in?sample=${sample}`);
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects an invalid ?limit= with 400', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    for (const limit of ['0', '-1', 'nope', '1.5']) {
      const { res } = await openRaw(`${h.baseUrl}/tap/in?limit=${limit}`);
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects an unknown ?format= with 400', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const { res } = await openRaw(`${h.baseUrl}/tap/in?format=xml`);
    expect(res.statusCode).toBe(400);
  });

  it('closes the pipeline-side subscription when the client disconnects (no leaked taps)', async () => {
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock }, [
      { events: [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')], delayMs: 10 },
    ]);
    cleanup = h.stop;

    expect(h.server.activeTapCount()).toBe(0);
    const { req, res } = await openRaw(`${h.baseUrl}/tap/in`);
    // Wait for the subscription before releasing the events, rather than inferring it from a
    // line arriving: on a real timer the events can be published before the tap is registered,
    // and then no line ever arrives (see the `?format=sse` test).
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(10);
    await readLines(res, 1);
    expect(h.server.activeTapCount()).toBe(1);

    req.destroy();
    await waitUntil(() => h.server.activeTapCount() === 0, 10_000);
    expect(h.server.activeTapCount()).toBe(0);
  }, 15_000);

  it('closing several taps leaves none open', async () => {
    const h = await createAdminHarness(undefined, [
      { events: [LogEvent.fromMessage('a')], delayMs: 50 },
    ]);
    cleanup = h.stop;

    const opened = await Promise.all([
      openRaw(`${h.baseUrl}/tap/in`),
      openRaw(`${h.baseUrl}/tap/in`),
      openRaw(`${h.baseUrl}/tap/in`),
    ]);
    await waitUntil(() => h.server.activeTapCount() === 3, 10_000);
    for (const { req } of opened) req.destroy();
    await waitUntil(() => h.server.activeTapCount() === 0, 10_000);
  }, 15_000);

  it('?sample= drops roughly the complementary fraction of events (statistical, wide margin)', async () => {
    const total = 300;
    const events = Array.from({ length: total }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock }, [{ events, delayMs: 10 }]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?sample=0.1`);
    // Hold the batch until the tap is subscribed, so "zero lines" can only mean the sampler
    // dropped everything — not that the events were published before anyone was listening.
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(10);
    // Wait for the first line rather than for a fixed window to elapse: the sampled events are
    // all written before `advance()` even returns, so "no lines yet" never means "not sampled
    // through" — only that this thread hasn't been scheduled to read them yet.
    const lines = await collectLines(res, { minLines: 1, quietMs: 200 });
    req.destroy();

    // True expectation is ~30 (10% of 300); this only checks sampling clearly did *something*,
    // with enough margin that flakiness from true randomness is effectively impossible.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(150);
  }, 15_000);

  it('a client that cannot keep up is dropped from, not allowed to block, delivery', async () => {
    // A client slow enough to fall behind is, from the tap subscriber's point of view,
    // indistinguishable from a burst too large for its queue to hold: both mean events arrive
    // faster than they're drained. Driving it via a burst (one send, far more events than the
    // configured queue capacity) exercises the exact same bounded-queue drop path deterministically
    // — unlike real socket-level backpressure, whose threshold depends on OS/loopback buffer
    // sizing and isn't reliable to depend on in a test.
    const total = 500;
    const events = Array.from({ length: total }, (_, i) => LogEvent.fromMessage(`m${i}`));
    // The burst must not fire until the tap is subscribed, or there is nothing to overflow the
    // queue. A manual clock makes that an ordering guarantee rather than a bet on opening the
    // connection within `delayMs`, while still publishing the whole burst in one go.
    const clock = new ManualClock();
    const h = await createAdminHarness({ clock, tap: { defaultQueueCapacity: 5 } }, [
      { events, delayMs: 50 },
    ]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in`);
    expect(res.statusCode).toBe(200);
    await waitUntil(() => h.server.activeTapCount() === 1);
    await clock.advance(50);
    // Poll the sink's own record of what it received, rather than the scripted source's
    // acknowledgement-completion promises: a tapped event's clone carries its own copy of the
    // original's finalizers (the same cloning `Event.clone()` uses for normal fan-out), and
    // nothing ever finishes a tap clone's finalizer, so waiting on end-to-end acknowledgement
    // here would wait forever whenever anything is tapped — a pre-existing behavior of
    // `@ferrule/runtime`'s `TapHub`, outside this package. The sink having recorded every event is
    // what "the tap never affects delivery" actually means for this test.
    await waitUntil(() => h.collector.events.length === total, 10_000);

    // Same reason as the `?sample=` test: what survived the queue is already written by now, so
    // wait for it to be read rather than for a window to expire.
    const lines = await collectLines(res, { minLines: 1, quietMs: 200 });
    req.destroy();

    expect(h.collector.events).toHaveLength(total); // the pipeline delivered every event...
    expect(lines.length).toBeGreaterThan(0);
    // Capacity 5, so at most 5 can have been sitting in the queue at once; a little slack for
    // whatever trickled out live while the burst was still being offered.
    expect(lines.length).toBeLessThanOrEqual(15);
  }, 15_000);
});
