import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@ferrule/core';
import { FerruleError } from '@ferrule/core';
import { routeTransform } from '@ferrule/operators';
import { buildTransform, counterMetric, logEvent, sealedBatch, spanEvent } from './helpers.js';

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

  it('renders a compile error against the route condition text, not the synthetic wrapper', async () => {
    const condition = '.status == "bad"';
    let message: string | undefined;
    try {
      await buildTransform(routeTransform, {
        routes: [{ name: 'bad', condition }],
        input_schema: { status: 'int' },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(FerruleError);
      message = (err as FerruleError).message;
    }
    expect(message).toBeDefined();
    expect(message).toContain(`| ${condition}\n`);
    expect(message).not.toContain('if !((');
    expect(message).not.toContain('{ drop }');
    expect(message).toContain('"bad">:1:1');
    expect(message).toContain(`| ${'^'.repeat(condition.length)} `);
  });
});

describe("route: event_kind: 'span'", () => {
  it('routes a span by attribute', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      event_kind: 'span',
      routes: [{ name: 'healthz', condition: '.attributes.http_route == "/healthz"' }],
    });
    const span = spanEvent({ attributes: { http_route: '/healthz' } });
    transform.process([span], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('healthz');
    expect(harness.pushed[0]!.event).toBe(span);
  });

  it('a route condition can read the derived, read-only `.duration` field', async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      event_kind: 'span',
      routes: [{ name: 'slow', condition: '.duration > 500000000' }],
    });
    const slow = spanEvent({ durationNanos: 600_000_000n });
    transform.process([slow], harness.out);
    expect(harness.pushed).toHaveLength(1);
    expect(harness.pushed[0]!.port).toBe('slow');
  });

  it('a type error in a span route condition is a build-time compile error', async () => {
    await expect(
      buildTransform(routeTransform, {
        event_kind: 'span',
        routes: [{ name: 'a', condition: '.name < 1' }], // .name is string, comparing to int
      }),
    ).rejects.toBeInstanceOf(FerruleError);
  });

  it("log and metric events pass through unchanged when event_kind is 'span'", async () => {
    const { transform, harness } = await buildTransform(routeTransform, {
      event_kind: 'span',
      routes: [{ name: 'a', condition: 'true' }],
    });
    const log = logEvent({});
    const metric = counterMetric('requests', 1);
    transform.process([log, metric], harness.out);
    expect(harness.pushed).toHaveLength(2);
    expect(harness.pushed[0]!.event).toBe(log);
    expect(harness.pushed[1]!.event).toBe(metric);
  });
});
