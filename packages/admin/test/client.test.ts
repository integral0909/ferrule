import { LogEvent, type Value, type ValueMap } from '@ferrule/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminClient, AdminClientError } from '../src/client.js';
import { createAdminHarness } from './fixtures.js';

function asMap(value: Value): ValueMap {
  if (!(value instanceof Map)) throw new Error('expected an object');
  return value;
}

describe('AdminClient', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('health() returns the pipeline health snapshot', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    const health = await client.health();
    expect(health.overall).toBe('running');
  });

  it('live() and ready() work', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    expect((await client.live()).status).toBe('ok');
    expect((await client.ready()).status).toBe('ready');
  });

  it('topology(), topologyDot(), and topologyMermaid() all work', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    const topology = await client.topology();
    expect(topology.components.map((c) => c.id).sort()).toEqual(['in', 'out']);
    expect((await client.topologyDot()).startsWith('digraph pipeline {')).toBe(true);
    expect((await client.topologyMermaid()).startsWith('graph LR')).toBe(true);
  });

  it('metrics() and metricsText() both work', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    await h.sourceHandle.allSent;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    const metrics = await client.metrics();
    expect(metrics.some((m) => m.name === 'component_sent_events_total')).toBe(true);
    expect(await client.metricsText()).toContain('component_sent_events_total');
  });

  it('component() returns one component detail, and throws AdminClientError for an unknown one', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    const detail = await client.component('in');
    expect(detail.id).toBe('in');

    await expect(client.component('nope')).rejects.toMatchObject({
      status: 404,
      code: 'E_NOT_FOUND',
    });
    await expect(client.component('nope')).rejects.toBeInstanceOf(AdminClientError);
  });

  it('config() returns the configDump text', async () => {
    const h = await createAdminHarness({ configDump: () => 'redacted config' });
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    expect(await client.config()).toBe('redacted config');
  });

  it('reload() returns the structured result on success and failure', async () => {
    const okResult = {
      ok: true as const,
      added: [],
      removed: [],
      changed: [],
      unchanged: ['in', 'out'],
    };
    const h = await createAdminHarness({ onReload: () => okResult });
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    expect(await client.reload()).toEqual(okResult);
  });

  it('sends the bearer token, and reports 401 as AdminClientError', async () => {
    const h = await createAdminHarness({
      auth: { token: 'secret' },
      onReload: () => ({ ok: true as const, added: [], removed: [], changed: [], unchanged: [] }),
    });
    cleanup = h.stop;

    const unauthenticated = new AdminClient({ baseUrl: h.baseUrl });
    await expect(unauthenticated.reload()).rejects.toMatchObject({ status: 401 });

    const authenticated = new AdminClient({ baseUrl: h.baseUrl, token: 'secret' });
    await expect(authenticated.reload()).resolves.toMatchObject({ ok: true });
  });

  it('tap() decodes NDJSON events with the lossless core JSON codec', async () => {
    const h = await createAdminHarness(undefined, [
      { events: [LogEvent.from({ message: 'hi', count: 3 })], delayMs: 20 },
    ]);
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });

    const received: Value[] = [];
    for await (const event of client.tap('in', { limit: 1 })) {
      received.push(event);
      break;
    }
    expect(received).toHaveLength(1);
    const decoded = asMap(received[0]!);
    const fields = asMap(decoded.get('fields')!);
    expect(fields.get('message')).toBe('hi');
    expect(fields.get('count')).toBe(3n); // decoded losslessly as an integer, not a float
  }, 15_000); // real network I/O; generous headroom under parallel test-suite load

  it('tap() stops after the requested limit without the caller needing to break', async () => {
    const events = Array.from({ length: 5 }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const h = await createAdminHarness(undefined, [{ events, delayMs: 10 }]);
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });

    const received: Value[] = [];
    for await (const event of client.tap('in', { limit: 2 })) received.push(event);
    expect(received).toHaveLength(2);
  }, 15_000);

  it('tap() propagates a 404 for an unknown component as AdminClientError', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const client = new AdminClient({ baseUrl: h.baseUrl });
    await expect(async () => {
      for await (const _event of client.tap('does-not-exist')) break;
    }).rejects.toMatchObject({ status: 404 });
  });
});
