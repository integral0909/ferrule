import { PgConnection, type PgConnectionOptions } from './connection.js';
import { PostgresProtocolError } from './errors.js';

export interface PgPoolOptions extends PgConnectionOptions {
  /** Maximum simultaneously open connections. Default 10. */
  maxConnections?: number;
  /** Query used by {@link PgPool.healthcheck}. Default `"SELECT 1"`. */
  healthCheckQuery?: string;
}

interface Waiter {
  readonly resolve: (conn: PgConnection) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A small connection pool: up to `maxConnections` lazily-opened {@link PgConnection}s, FIFO
 * waiters when the pool is exhausted, and connections that fail are discarded (not returned to
 * the idle set) so a broken socket never poisons a future acquire.
 */
export class PgPool {
  private readonly idle: PgConnection[] = [];
  private readonly waiters: Waiter[] = [];
  private total = 0;
  private closed = false;

  constructor(private readonly options: PgPoolOptions) {}

  get stats(): { total: number; idle: number; waiting: number } {
    return { total: this.total, idle: this.idle.length, waiting: this.waiters.length };
  }

  async acquire(): Promise<PgConnection> {
    if (this.closed) throw new PostgresProtocolError('connection pool is closed');
    while (this.idle.length > 0) {
      const conn = this.idle.pop()!;
      if (!conn.isClosed) return conn;
      this.total--;
    }
    const max = this.options.maxConnections ?? 10;
    if (this.total < max) {
      this.total++;
      try {
        const conn = new PgConnection(this.options);
        await conn.connect();
        return conn;
      } catch (error) {
        this.total--;
        throw error;
      }
    }
    return new Promise<PgConnection>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Returns a connection to the pool. `healthy: false` (the default after any thrown error)
   * closes it instead, and — if callers are waiting — opens a replacement for them. */
  release(conn: PgConnection, healthy: boolean): void {
    if (this.closed || !healthy || conn.isClosed) {
      this.total--;
      void conn.close();
      this.admitWaiter();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(conn);
      return;
    }
    this.idle.push(conn);
  }

  private admitWaiter(): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) return;
    if (this.total >= (this.options.maxConnections ?? 10)) {
      // Shouldn't normally happen (a slot was just freed), but stay safe: re-queue.
      this.waiters.unshift(waiter);
      return;
    }
    this.total++;
    const conn = new PgConnection(this.options);
    conn
      .connect()
      .then(() => waiter.resolve(conn))
      .catch((error: unknown) => {
        this.total--;
        waiter.reject(error);
      });
  }

  /** Acquires a connection, runs `fn`, and releases it — healthy on success, discarded on a
   * thrown error. */
  async withConnection<T>(fn: (conn: PgConnection) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      const result = await fn(conn);
      this.release(conn, true);
      return result;
    } catch (error) {
      this.release(conn, false);
      throw error;
    }
  }

  async healthcheck(): Promise<void> {
    await this.withConnection(async (conn) => {
      await conn.simpleQuery(this.options.healthCheckQuery ?? 'SELECT 1');
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(new PostgresProtocolError('connection pool closed'));
    }
    const conns = this.idle.splice(0);
    await Promise.all(conns.map((c) => c.close()));
  }
}
