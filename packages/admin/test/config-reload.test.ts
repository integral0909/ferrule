import { afterEach, describe, expect, it } from 'vitest';
import type { ReloadResult } from '@ferrule/runtime';
import { createAdminHarness } from './fixtures.js';

describe('GET /config', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('returns the text the configDump callback produces', async () => {
    const h = await createAdminHarness({
      configDump: () => 'sources:\n  in:\n    type: admin_test_source\n# secret redacted\n',
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain('admin_test_source');
    expect(text).toContain('redacted');
  });

  it('supports an async configDump callback', async () => {
    const h = await createAdminHarness({
      configDump: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return 'async config text';
      },
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/config`);
    expect(await res.text()).toBe('async config text');
  });
});

describe('POST /reload', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('returns 200 and the structured result on success', async () => {
    const result: ReloadResult = {
      ok: true,
      added: ['new_sink'],
      removed: [],
      changed: [],
      unchanged: ['in', 'out'],
    };
    const h = await createAdminHarness({ onReload: () => result });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it('returns 422 and validation diagnostics on failure', async () => {
    const result: ReloadResult = {
      ok: false,
      errors: [
        {
          severity: 'error',
          code: 'E_UNKNOWN_INPUT',
          message: 'bad reference',
          componentId: 'out',
        },
      ],
    };
    const h = await createAdminHarness({ onReload: () => result });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(result);
  });

  it('actually drives Pipeline.reload and reports what changed', async () => {
    const h = await createAdminHarness({
      onReload: () => h.pipeline.reload(h.spec), // identical spec: nothing changes
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReloadResult;
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.added).toEqual([]);
      expect(body.removed).toEqual([]);
      expect(body.changed).toEqual([]);
      expect([...body.unchanged].sort()).toEqual(['in', 'out']);
    }
  });
});
