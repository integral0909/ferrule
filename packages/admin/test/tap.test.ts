import { LogEvent, parseJson, type ValueMap } from '@ferrule/core';
import { ManualClock } from '@ferrule/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminHarness } from './fixtures.js';
import { collectLinesForMs, openRaw, readLines, waitUntil } from './tap-helpers.js';

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
    const h = await createAdminHarness(undefined, [
      { events: [LogEvent.fromMessage('hi')], delayMs: 20 },
    ]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?format=sse`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
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

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?format=sse`);
    expect(res.statusCode).toBe(200);

    await waitUntil(() => clock.pendingCount >= 1, 10_000);
    const heartbeats = collectLinesForMs(res, 200);
    await clock.advance(1000);
    const lines = await heartbeats;
    req.destroy();

    expect(lines.some((l) => l.includes('heartbeat'))).toBe(true);
  }, 15_000);

  it('stops after ?limit= events', async () => {
    const events = Array.from({ length: 5 }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const h = await createAdminHarness(undefined, [{ events, delayMs: 10 }]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?limit=3`);
    const lines = await readLines(res, 3);
    // The server closes the stream once the limit is reached; give it a moment, then confirm no
    // further data (and that the connection ended).
    const extra = await collectLinesForMs(res, 200);
    req.destroy();
    expect(lines).toHaveLength(3);
    expect(extra).toHaveLength(0);
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
    const h = await createAdminHarness(undefined, [
      { events: [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')], delayMs: 10 },
    ]);
    cleanup = h.stop;

    expect(h.server.activeTapCount()).toBe(0);
    const { req, res } = await openRaw(`${h.baseUrl}/tap/in`);
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
    const h = await createAdminHarness(undefined, [{ events, delayMs: 10 }]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in?sample=0.1`);
    // The whole batch is published essentially at once; give it a generous window to arrive.
    const lines = await collectLinesForMs(res, 500);
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
    // delayMs gives the test a real window to open the tap connection before the burst fires;
    // without it the whole burst could be published before any subscriber exists to see it.
    const h = await createAdminHarness({ tap: { defaultQueueCapacity: 5 } }, [
      { events, delayMs: 50 },
    ]);
    cleanup = h.stop;

    const { req, res } = await openRaw(`${h.baseUrl}/tap/in`);
    expect(res.statusCode).toBe(200);
    // Poll the sink's own record of what it received, rather than the scripted source's
    // acknowledgement-completion promises: a tapped event's clone carries its own copy of the
    // original's finalizers (the same cloning `Event.clone()` uses for normal fan-out), and
    // nothing ever finishes a tap clone's finalizer, so waiting on end-to-end acknowledgement
    // here would wait forever whenever anything is tapped — a pre-existing behavior of
    // `@ferrule/runtime`'s `TapHub`, outside this package. The sink having recorded every event is
    // what "the tap never affects delivery" actually means for this test.
    await waitUntil(() => h.collector.events.length === total, 10_000);

    const lines = await collectLinesForMs(res, 300);
    req.destroy();

    expect(h.collector.events).toHaveLength(total); // the pipeline delivered every event...
    expect(lines.length).toBeGreaterThan(0);
    // Capacity 5, so at most 5 can have been sitting in the queue at once; a little slack for
    // whatever trickled out live while the burst was still being offered.
    expect(lines.length).toBeLessThanOrEqual(15);
  }, 15_000);
});
