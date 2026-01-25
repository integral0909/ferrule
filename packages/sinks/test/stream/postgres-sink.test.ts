import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, Timestamp, type DeliveryStatus } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import {
  coerceColumnValue,
  createPostgresSink,
  quoteIdentifier,
  type PostgresSinkOptions,
} from '../../src/postgres/sink.js';
import { FakePostgresServer } from './support/fake-postgres-server.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

let server: FakePostgresServer | undefined;
afterEach(async () => {
  if (server !== undefined) await server.close();
  server = undefined;
});

function baseOptions(
  port: number,
  overrides: Partial<PostgresSinkOptions> = {},
): PostgresSinkOptions {
  return {
    host: '127.0.0.1',
    port,
    database: 'db',
    user: 'u',
    applicationName: 'ferrule-test',
    table: 'events',
    columns: [
      { name: 'id', field: ['id'], type: 'text' },
      { name: 'message', field: ['message'], type: 'text' },
    ],
    copyFormat: 'text',
    maxConnections: 3,
    connectTimeout: 2_000,
    batchMaxEvents: 100,
    batchMaxBytes: 1024 * 1024,
    batchTimeout: 200,
    bisectOnFailure: true,
    retryInitialDelay: 5,
    retryMaxDelay: 20,
    ...overrides,
  };
}

describe('quoteIdentifier', () => {
  it('quotes a plain identifier', () => {
    expect(quoteIdentifier('events')).toBe('"events"');
  });

  it('doubles embedded double quotes', () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
  });

  it('quotes each segment of a schema-qualified name separately', () => {
    expect(quoteIdentifier('public.events')).toBe('"public"."events"');
  });
});

describe('coerceColumnValue', () => {
  const column = (type: PostgresSinkOptions['columns'][number]['type']) => ({
    name: 'c',
    field: ['v'] as const,
    type,
  });

  it('coerces text via stringifyValue', () => {
    const event = LogEvent.from({ v: 'hello' });
    expect(coerceColumnValue(event, column('text'))).toBe('hello');
  });

  it('coerces integer/bigint fields', () => {
    const event = LogEvent.from({ v: 42n });
    expect(coerceColumnValue(event, column('integer'))).toBe('42');
  });

  it('coerces boolean fields', () => {
    expect(coerceColumnValue(LogEvent.from({ v: true }), column('boolean'))).toBe('true');
    expect(coerceColumnValue(LogEvent.from({ v: false }), column('boolean'))).toBe('false');
  });

  it('coerces timestamp fields to RFC 3339', () => {
    const ts = Timestamp.fromMillis(0);
    const event = new LogEvent(new Map([['v', ts]]));
    expect(coerceColumnValue(event, column('timestamp'))).toBe(ts.toISOString());
  });

  it('coerces bytes fields to Postgres hex bytea format', () => {
    const event = new LogEvent(new Map([['v', new Uint8Array([0xde, 0xad, 0xbe, 0xef])]]));
    expect(coerceColumnValue(event, column('bytes'))).toBe('\\xdeadbeef');
  });

  it('returns null for a missing field', () => {
    const event = LogEvent.fromMessage('x');
    expect(coerceColumnValue(event, column('text'))).toBeNull();
  });

  it('returns null for a type mismatch rather than throwing', () => {
    const event = LogEvent.from({ v: 'not a number' });
    expect(coerceColumnValue(event, column('integer'))).toBeNull();
  });
});

describe('postgres sink', () => {
  it('delivers a batch of events via COPY', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    const sink = createPostgresSink(baseOptions(port));
    const ctx = createTestSinkContext();
    const events = [
      LogEvent.from({ id: '1', message: 'a' }),
      LogEvent.from({ id: '2', message: 'b' }),
    ];
    const completions = events.map(withFinalizer);

    const running = sink.run(ctx.ctx);
    await ctx.feed(events);
    ctx.close();
    await running;

    for (const c of completions) await expect(c).resolves.toBe('delivered');
    expect(server.receivedCopyData).toHaveLength(1);
    expect(server.receivedCopyData[0]!.toString('utf8')).toBe('1\ta\n2\tb\n');
  });

  it('bisects a batch on a permanent error, rejecting only the offending row', async () => {
    server = new FakePostgresServer({
      auth: 'trust',
      onCopy: (_sql, data) => {
        // Reject any COPY payload that contains the marker row; accept everything else.
        if (data.toString('utf8').includes('bad\tpoison')) {
          return {
            ok: false,
            sqlState: '23505',
            message: 'duplicate key value violates unique constraint',
          };
        }
        return { ok: true };
      },
    });
    const port = await server.listen();
    const sink = createPostgresSink(baseOptions(port, { batchMaxEvents: 10 }));
    const ctx = createTestSinkContext();
    const events = [
      LogEvent.from({ id: '1', message: 'ok-1' }),
      LogEvent.from({ id: '2', message: 'ok-2' }),
      LogEvent.from({ id: 'bad', message: 'poison' }),
      LogEvent.from({ id: '3', message: 'ok-3' }),
    ];
    const completions = events.map(withFinalizer);

    const running = sink.run(ctx.ctx);
    await ctx.feed(events);
    ctx.close();
    await running;

    const statuses = await Promise.all(completions);
    expect(statuses).toEqual(['delivered', 'delivered', 'rejected', 'delivered']);
  });

  it('rejects the whole batch on a permanent error when bisectOnFailure is false', async () => {
    server = new FakePostgresServer({
      auth: 'trust',
      onCopy: () => ({ ok: false, sqlState: '22P02', message: 'invalid input syntax' }),
    });
    const port = await server.listen();
    const sink = createPostgresSink(baseOptions(port, { bisectOnFailure: false }));
    const ctx = createTestSinkContext();
    const events = [
      LogEvent.from({ id: '1', message: 'a' }),
      LogEvent.from({ id: '2', message: 'b' }),
    ];
    const completions = events.map(withFinalizer);

    const running = sink.run(ctx.ctx);
    await ctx.feed(events);
    ctx.close();
    await running;

    for (const c of completions) await expect(c).resolves.toBe('rejected');
  });

  it('retries (driven by the manual clock) after a connection-class failure, then delivers', async () => {
    let attempt = 0;
    server = new FakePostgresServer({
      auth: 'trust',
      onCopy: () => {
        attempt++;
        if (attempt === 1) return { ok: false, sqlState: '08006', message: 'connection failure' };
        return { ok: true };
      },
    });
    const port = await server.listen();
    const sink = createPostgresSink(baseOptions(port, { retryInitialDelay: 5, retryMaxDelay: 20 }));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ id: '1', message: 'retry-me' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();

    // The first attempt (dial, authenticate, COPY, fail) is real async I/O against the fake
    // server, not driven by the manual clock, so give it real wall-clock ticks to progress
    // between clock advances (which only matter for the retry policy's backoff sleep).
    for (let i = 0; i < 200 && attempt < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ctx.clock.advance(20);
    }
    await running;
    await expect(completion).resolves.toBe('delivered');
    expect(attempt).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('healthcheck succeeds against a reachable server', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    const sink = createPostgresSink(baseOptions(port));
    const ctx = createTestSinkContext();
    await expect(sink.healthcheck?.(ctx.ctx)).resolves.toBeUndefined();
  });
});
