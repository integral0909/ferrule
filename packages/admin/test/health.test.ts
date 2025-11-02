import { afterEach, describe, expect, it } from 'vitest';
import type { PipelineHealth } from '@ferrule/runtime';
import {
  createAdminHarness,
  createDegradedHarness,
  createHarness,
  startAdmin,
} from './fixtures.js';

describe('GET /health, /health/live, /health/ready', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('reports 200 and overall: running for a healthy pipeline', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;

    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as PipelineHealth;
    expect(body.overall).toBe('running');
    expect(body.components.map((c) => c.id).sort()).toEqual(['in', 'out']);
    expect(body.components.every((c) => c.state === 'running')).toBe(true);

    expect((await fetch(`${h.baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${h.baseUrl}/health/ready`)).status).toBe(200);
    const ready = (await (await fetch(`${h.baseUrl}/health/ready`)).json()) as { status: string };
    expect(ready.status).toBe('ready');
  });

  it('reports 503 for /health, live but not ready for a degraded pipeline', async () => {
    const degraded = await createDegradedHarness();
    const admin = await startAdmin({ pipeline: degraded.pipeline, metrics: degraded.metrics });
    cleanup = async () => {
      await admin.stop();
      await degraded.stop();
    };

    const health = await fetch(`${admin.baseUrl}/health`);
    expect(health.status).toBe(503);
    const body = (await health.json()) as PipelineHealth;
    expect(body.overall).toBe('degraded');
    expect(body.components.find((c) => c.id === 'out')?.state).toBe('failed');
    expect(body.components.find((c) => c.id === 'out')?.error).toBeDefined();

    expect((await fetch(`${admin.baseUrl}/health/live`)).status).toBe(200);
    const ready = await fetch(`${admin.baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { status: string }).status).toBe('not_ready');
  });

  it('reports 503 for /health and /health/ready once the pipeline has fully stopped', async () => {
    const h = await createHarness();
    const admin = await startAdmin({ pipeline: h.pipeline, metrics: h.metrics });
    await h.pipeline.stop();
    cleanup = admin.stop;

    const health = await fetch(`${admin.baseUrl}/health`);
    expect(health.status).toBe(503);
    expect(((await health.json()) as PipelineHealth).overall).toBe('stopped');
    expect((await fetch(`${admin.baseUrl}/health/ready`)).status).toBe(503);
  });
});
