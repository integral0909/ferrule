import { afterEach, describe, expect, it } from 'vitest';
import type { TopologySnapshot } from '@ferrule/runtime';
import type { ComponentDetail, MetricEventJson } from '../src/types.js';
import { createAdminHarness } from './fixtures.js';

describe('GET /topology', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('returns the running graph as JSON by default', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/topology`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TopologySnapshot;
    expect(body).toEqual({
      components: [
        { id: 'in', kind: 'source', type: 'admin_test_source', inputs: [] },
        { id: 'out', kind: 'sink', type: 'admin_test_sink', inputs: ['in'] },
      ],
    });
  });

  it('?format=dot renders a Graphviz digraph containing every component and edge', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/topology?format=dot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/vnd\.graphviz/);
    const text = await res.text();
    expect(text.startsWith('digraph pipeline {')).toBe(true);
    expect(text).toContain('"in"');
    expect(text).toContain('"out"');
    expect(text).toContain('"in" -> "out"');
  });

  it('?format=mermaid renders a Mermaid flowchart', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/topology?format=mermaid`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith('graph LR')).toBe(true);
    expect(text).toContain('n_in');
    expect(text).toContain('n_out');
  });

  it('rejects an unknown format with 400', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/topology?format=svg`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_BAD_REQUEST');
  });
});

describe('GET /metrics', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('returns Prometheus text exposition format by default', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    await h.sourceHandle.allSent;
    const res = await fetch(`${h.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain('component_sent_events_total');
    expect(text).toContain('component_id="in"');
  });

  it('?format=json returns a JSON array of metric events', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    await h.sourceHandle.allSent;
    const res = await fetch(`${h.baseUrl}/metrics?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const events = (await res.json()) as MetricEventJson[];
    expect(events.length).toBeGreaterThan(0);
    const sentEvents = events.find(
      (e) => e.name === 'component_sent_events_total' && e.tags['component_id'] === 'in',
    );
    expect(sentEvents).toBeDefined();
    expect(sentEvents!.value).toEqual({ type: 'counter', value: 2 });
  });

  it('honors an Accept: application/json header as well as ?format=json', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/metrics`, { headers: { Accept: 'application/json' } });
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });
});

describe('GET /components/:id', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("returns a component's health and its own metrics", async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    await h.sourceHandle.allSent;
    const res = await fetch(`${h.baseUrl}/components/in`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as ComponentDetail;
    expect(detail.id).toBe('in');
    expect(detail.kind).toBe('source');
    expect(detail.type).toBe('admin_test_source');
    expect(detail.state).toBe('running');
    expect(detail.metrics.every((m) => m.tags['component_id'] === 'in')).toBe(true);
    expect(detail.metrics.some((m) => m.name === 'component_sent_events_total')).toBe(true);
  });

  it('returns 404 for an unknown component', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/components/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_NOT_FOUND');
  });
});
