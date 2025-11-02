import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MethodNotAllowedError, NotFoundError } from '../src/errors.js';
import { Router, type RouteContext } from '../src/router.js';

describe('Router', () => {
  it('matches a literal path', () => {
    const router = new Router();
    let called = false;
    router.get('/health', () => {
      called = true;
    });
    const req = { method: 'GET' } as Parameters<Router['resolve']>[0];
    const { handler, params } = router.resolve(req, new URL('http://x/health'));
    void handler({ params } as RouteContext);
    expect(called).toBe(true);
    expect(params).toEqual({});
  });

  it('extracts :param segments, URI-decoded', () => {
    const router = new Router();
    router.get('/components/:id', () => undefined);
    const req = { method: 'GET' } as Parameters<Router['resolve']>[0];
    const { params } = router.resolve(req, new URL('http://x/components/my%20service'));
    expect(params).toEqual({ id: 'my service' });
  });

  it('does not match a path with a different segment count', () => {
    const router = new Router();
    router.get('/components/:id', () => undefined);
    const req = { method: 'GET' } as Parameters<Router['resolve']>[0];
    expect(() => router.resolve(req, new URL('http://x/components'))).toThrow(NotFoundError);
    expect(() => router.resolve(req, new URL('http://x/components/a/b'))).toThrow(NotFoundError);
  });

  it('throws NotFoundError when no route matches the path at all', () => {
    const router = new Router();
    router.get('/health', () => undefined);
    const req = { method: 'GET' } as Parameters<Router['resolve']>[0];
    expect(() => router.resolve(req, new URL('http://x/nope'))).toThrow(NotFoundError);
  });

  it('throws MethodNotAllowedError (listing every matching method) when the path matches but not the method', () => {
    const router = new Router();
    router.get('/reload', () => undefined);
    router.post('/reload', () => undefined);
    const req = { method: 'PUT' } as Parameters<Router['resolve']>[0];
    try {
      router.resolve(req, new URL('http://x/reload'));
      expect.unreachable('expected resolve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MethodNotAllowedError);
      expect([...(error as MethodNotAllowedError).allowed].sort()).toEqual(['GET', 'POST']);
    }
  });

  it('ignores empty path segments from leading/trailing/duplicate slashes', () => {
    const router = new Router();
    let called = false;
    router.get('/tap/:component', () => {
      called = true;
    });
    const req = { method: 'GET' } as Parameters<Router['resolve']>[0];
    const { handler, params } = router.resolve(req, new URL('http://x//tap/app_logs/'));
    void handler({ params } as RouteContext);
    expect(called).toBe(true);
    expect(params).toEqual({ component: 'app_logs' });
  });
});

/** A minimal end-to-end check that the router is actually wired into a real `node:http` server
 * correctly (path params reach the handler, unmatched paths 404) — the admin server's own tests
 * cover the full route table; this just proves the wiring pattern itself over a real socket. */
describe('Router over a real HTTP server', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('dispatches to the right handler with path params, real request/response', async () => {
    const router = new Router();
    router.get('/echo/:word', (ctx) => {
      ctx.res.writeHead(200, { 'Content-Type': 'text/plain' });
      ctx.res.end(ctx.params['word']);
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { handler, params } = router.resolve(req, url);
      void handler({ req, res, url, params });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;

    const body = await get(`http://127.0.0.1:${port}/echo/hi-there`);
    expect(body).toBe('hi-there');
  });
});

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    httpRequest(url, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
      .on('error', reject)
      .end();
  });
}
