import { afterEach, describe, expect, it } from 'vitest';
import { PgPool } from '../../src/postgres/pool.js';
import { FakePostgresServer } from './support/fake-postgres-server.js';

let server: FakePostgresServer | undefined;
let pool: PgPool | undefined;

afterEach(async () => {
  if (pool !== undefined) await pool.close();
  if (server !== undefined) await server.close();
  pool = undefined;
  server = undefined;
});

describe('PgPool', () => {
  it('opens connections lazily up to maxConnections and reuses released ones', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    pool = new PgPool({ host: '127.0.0.1', port, database: 'db', user: 'u', maxConnections: 2 });

    const a = await pool.acquire();
    expect(pool.stats.total).toBe(1);
    const b = await pool.acquire();
    expect(pool.stats.total).toBe(2);
    pool.release(a, true);
    expect(pool.stats.idle).toBe(1);
    const c = await pool.acquire(); // should reuse `a`'s connection rather than opening a third
    expect(pool.stats.total).toBe(2);
    pool.release(b, true);
    pool.release(c, true);
  });

  it('queues acquires beyond maxConnections and resolves them on release', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    pool = new PgPool({ host: '127.0.0.1', port, database: 'db', user: 'u', maxConnections: 1 });

    const a = await pool.acquire();
    let resolved = false;
    const pending = pool.acquire().then((conn) => {
      resolved = true;
      return conn;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    pool.release(a, true);
    const b = await pending;
    expect(resolved).toBe(true);
    pool.release(b, true);
  });

  it('discards an unhealthy connection instead of returning it to the idle set', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    pool = new PgPool({ host: '127.0.0.1', port, database: 'db', user: 'u', maxConnections: 2 });
    const a = await pool.acquire();
    pool.release(a, false);
    expect(pool.stats.total).toBe(0);
    expect(pool.stats.idle).toBe(0);
  });

  it('withConnection releases healthy on success and discards on error', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    pool = new PgPool({ host: '127.0.0.1', port, database: 'db', user: 'u', maxConnections: 3 });

    await pool.withConnection(async (conn) => {
      await conn.simpleQuery('SELECT 1');
    });
    expect(pool.stats.idle).toBe(1);
    expect(pool.stats.total).toBe(1);

    // acquire() prefers an idle connection, so this reuses the one above rather than opening a
    // second one; since the callback throws, that connection is discarded rather than returned.
    await expect(
      pool.withConnection(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pool.stats.idle).toBe(0);
    expect(pool.stats.total).toBe(0);
  });

  it('healthcheck() succeeds against a reachable, authenticated server', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    pool = new PgPool({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await expect(pool.healthcheck()).resolves.toBeUndefined();
  });

  it('close() rejects queued waiters and closes idle connections', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    pool = new PgPool({ host: '127.0.0.1', port, database: 'db', user: 'u', maxConnections: 1 });
    const held = await pool.acquire(); // keeps the pool "full" so the next acquire() queues
    const waiting = pool.acquire();
    await pool.close();
    await expect(waiting).rejects.toThrow();
    // pool.close() only closes *idle* connections and rejects queued waiters; a connection the
    // caller still holds checked out is the caller's responsibility to close.
    await held.close();
    pool = undefined;
  });
});
