import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminHarness } from './fixtures.js';

/**
 * `fetch()` refuses to let callers set a `Host` header (it's on the Fetch spec's forbidden header
 * list and gets silently overwritten with the real one), so the DNS-rebinding guard tests below
 * use `node:http` directly, which has no such restriction.
 */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('security: routing basics', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('returns 404 with a JSON error envelope for an unknown path', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('E_NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns 405 with an Allow header for a path that exists under a different method', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_METHOD_NOT_ALLOWED');
  });

  it('never sends a stack trace in an error body', async () => {
    const h = await createAdminHarness({
      onReload: () => {
        throw new Error('a genuine bug with a stack trace attached');
      },
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('.ts:');
    expect(text).not.toContain('at ');
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('E_INTERNAL');
    expect(body.error.message).toBe('internal server error');
  });

  it('applies X-Content-Type-Options and Cache-Control to every response, including errors', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    for (const res of [await fetch(`${h.baseUrl}/health`), await fetch(`${h.baseUrl}/nope`)]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('never sends an Access-Control-Allow-Origin header (no CORS support)', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('security: bearer token auth', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('does not require a token for GET endpoints when auth is configured without requireForAll', async () => {
    const h = await createAdminHarness({ auth: { token: 'secret-token' } });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects POST /reload with 401 when no token is sent', async () => {
    const h = await createAdminHarness({
      auth: { token: 'secret-token' },
      onReload: () => ({
        ok: true,
        added: [],
        removed: [],
        changed: [],
        unchanged: [],
      }),
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_UNAUTHORIZED');
  });

  it('rejects POST /reload with 401 when the wrong token is sent', async () => {
    const h = await createAdminHarness({
      auth: { token: 'secret-token' },
      onReload: () => ({
        ok: true,
        added: [],
        removed: [],
        changed: [],
        unchanged: [],
      }),
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts POST /reload with the correct token', async () => {
    const h = await createAdminHarness({
      auth: { token: 'secret-token' },
      onReload: () => ({
        ok: true,
        added: [],
        removed: [],
        changed: [],
        unchanged: [],
      }),
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(res.status).toBe(200);
  });

  it('ignores a malformed Authorization header (missing "Bearer " prefix) as no token', async () => {
    const h = await createAdminHarness({
      auth: { token: 'secret-token' },
      onReload: () => ({
        ok: true,
        added: [],
        removed: [],
        changed: [],
        unchanged: [],
      }),
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, {
      method: 'POST',
      headers: { Authorization: 'secret-token' },
    });
    expect(res.status).toBe(401);
  });

  it('requireForAll extends the token requirement to GET endpoints, including health', async () => {
    const h = await createAdminHarness({ auth: { token: 'secret-token', requireForAll: true } });
    cleanup = h.stop;
    const unauthenticated = await fetch(`${h.baseUrl}/health`);
    expect(unauthenticated.status).toBe(401);
    const authenticated = await fetch(`${h.baseUrl}/health`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(authenticated.status).toBe(200);
  });
});

describe('security: DNS-rebinding Host header guard', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('rejects a request whose Host header names something other than the loopback address, with 403', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const port = new URL(h.baseUrl).port;
    const res = await rawGet(`${h.baseUrl}/health`, { Host: `attacker.example:${port}` });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('E_FORBIDDEN_HOST');
  });

  it('accepts the real loopback Host (what a normal client sends) unmodified', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await rawGet(`${h.baseUrl}/health`, { Host: new URL(h.baseUrl).host });
    expect(res.status).toBe(200);
  });

  it('rejects a Host naming the right IP but the wrong port', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await rawGet(`${h.baseUrl}/health`, { Host: '127.0.0.1:1' });
    expect(res.status).toBe(403);
  });

  it('accepts an explicitly configured extra allowed host', async () => {
    const h = await createAdminHarness({ allowedHosts: ['admin.internal'] });
    cleanup = h.stop;
    const res = await rawGet(`${h.baseUrl}/health`, { Host: 'admin.internal' });
    expect(res.status).toBe(200);
  });
});

describe('security: request body size limit', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('rejects a POST body larger than maxBodyBytes with 413', async () => {
    const h = await createAdminHarness({
      maxBodyBytes: 16,
      onReload: () => ({ ok: true, added: [], removed: [], changed: [], unchanged: [] }),
    });
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, {
      method: 'POST',
      body: 'x'.repeat(1024),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_PAYLOAD_TOO_LARGE');
  });
});

describe('security: endpoints without a configured callback', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('GET /config returns 404 E_NOT_CONFIGURED when no configDump was supplied', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/config`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_NOT_CONFIGURED');
  });

  it('POST /reload returns 404 E_NOT_CONFIGURED when no onReload was supplied', async () => {
    const h = await createAdminHarness();
    cleanup = h.stop;
    const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_NOT_CONFIGURED');
  });
});
