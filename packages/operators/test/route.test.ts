import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
import { FerruleError } from '@ferrule/core';
import { routeTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

const twoRoutes = {
  routes: [
    { name: 'errors', condition: '.status >= 500' },
    { name: 'client_errors', condition: '.status >= 400 && .status < 500' },
  ],
};

describe('route', () => {
  it('sends an event to the one route whose condition matches', async () => {
    const { transform, harness } = await buildTransform(routeTransform, twoRoutes);
    transform.process([logEvent({ status: 500 })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('errors');
  });

  it('fans out to every matching route, cloning for extra matches', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      routes: [
        { name: 'a', condition: '.status >= 200' },
        { name: 'b', condition: '.status >= 200' },
        { name: 'c', condition: '.status >= 200' },
      ],
    });
    const events = [logEvent({ status: 200 })];
    const original = events[0]!;
    transform.process(events, harness.out);
    expect(harness.pushed.map((p) => p.port)).toEqual(['a', 'b', 'c']);
    // The first match reuses the original object; later matches are clones.
    expect(harness.pushed[0]!.event).toBe(original);
    expect(harness.pushed[1]!.event).not.toBe(original);
    expect(harness.pushed[2]!.event).not.toBe(original);
    expect((harness.pushed[1]!.event as LogEvent).get('status')).toBe(200n);
  });

  it('a single-route event batch acks only once every clone finishes', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      routes: [
        { name: 'a', condition: 'true' },
        { name: 'b', condition: 'true' },
      ],
    });
    const events = [logEvent({})];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(2);
    harness.pushed[0]!.event.metadata.finalizers.finish('delivered');
    let settled = false;
    void batch.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    harness.pushed[1]!.event.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('unmatched events go to _unmatched by default', async () => {
    const { transform, harness } = await buildTransform(routeTransform, twoRoutes);
    transform.process([logEvent({ status: 200 })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('_unmatched');
  });

  it('unmatched_port renames the unmatched port', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      ...twoRoutes,
      unmatched_port: 'ok',
    });
    transform.process([logEvent({ status: 200 })], harness.out);
    expect(harness.pushed[0]!.port).toBe('ok');
  });

  it('route_unmatched: false drops and finishes unmatched events delivered', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      ...twoRoutes,
      route_unmatched: false,
    });
    const events = [logEvent({ status: 200 })];
    const batch = sealedBatch(events);
    transform.process(events, harness.out);
    expect(harness.pushed).toHaveLength(0);
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('on_error: drop (default) treats an aborted condition as not matched', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      routes: [{ name: 'a', condition: '.enabled' }],
    });
    transform.process([logEvent({ enabled: 'not a bool' })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('_unmatched');
  });

  it('on_error: keep treats an aborted condition as matched', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      routes: [{ name: 'a', condition: '.enabled' }],
      on_error: 'keep',
    });
    transform.process([logEvent({ enabled: 'not a bool' })], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('a');
  });

  it('rejects duplicate route names', () => {
    expect(() =>
      routeTransform.options.parse({
        routes: [
          { name: 'a', condition: 'true' },
          { name: 'a', condition: 'false' },
        ],
      }),
    ).toThrow();
  });

  it('rejects unmatched_port colliding with a route name', () => {
    expect(() =>
      routeTransform.options.parse({
        routes: [{ name: 'ok', condition: 'true' }],
        unmatched_port: 'ok',
      }),
    ).toThrow();
  });

  it('outputs() declares every route plus the unmatched port', () => {
    const options = routeTransform.options.parse(twoRoutes);
    expect(routeTransform.outputs?.(options).map((p) => p.name)).toEqual([
      'errors',
      'client_errors',
      '_unmatched',
    ]);
  });

  it('outputs() omits the unmatched port when route_unmatched is false', () => {
    const options = routeTransform.options.parse({ ...twoRoutes, route_unmatched: false });
    expect(routeTransform.outputs?.(options).map((p) => p.name)).toEqual([
      'errors',
      'client_errors',
    ]);
  });

  it('surfaces a compile error naming the offending route', async () => {
    await expect(
      buildTransform(routeTransform, { routes: [{ name: 'bad', condition: '.a ==' }] }),
    ).rejects.toBeInstanceOf(FerruleError);
  });
});
