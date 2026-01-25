import { afterEach, describe, expect, it } from 'vitest';
import { FerruleError, LogEvent } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import {
  clickhouseSink,
  clickhouseSinkOptions,
  quoteClickHouseIdentifier,
} from '../../src/http/sinks/clickhouse.js';
import { startServer, testBuildContext, withNotifier, type TestServer } from './helpers.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('quoteClickHouseIdentifier', () => {
  it('backtick-quotes a valid identifier', () => {
    expect(quoteClickHouseIdentifier('events')).toBe('`events`');
    expect(quoteClickHouseIdentifier('_my_table_1')).toBe('`_my_table_1`');
  });

  it('rejects identifiers outside the safe pattern', () => {
    for (const bad of ['1table', 'a-b', 'a b', 'a;DROP TABLE x', 'a`b', '']) {
      expect(() => quoteClickHouseIdentifier(bad)).toThrow(FerruleError);
    }
  });
});

describe('clickhouse sink', () => {
  it('inserts via the HTTP interface with a JSONEachRow body and quoted db.table', async () => {
    server = await startServer((_req, res) => res.end());
    const options = clickhouseSinkOptions.parse({
      url: server.url,
      database: 'logs_db',
      table: 'events',
    });
    const sink = await clickhouseSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const { event, completion } = withNotifier(LogEvent.from({ message: 'hi', count: 3 }));
    await harness.feed([event]);
    harness.close();
    await run;

    await expect(completion).resolves.toBe('delivered');
    const req = server.requests[0]!;
    const url = new URL(req.url, 'http://x');
    expect(url.searchParams.get('query')).toBe('INSERT INTO `logs_db`.`events` FORMAT JSONEachRow');
    expect(req.headers['content-type']).toBe('application/x-ndjson');
    expect(JSON.parse(req.body.toString('utf8').trim())).toEqual({ message: 'hi', count: 3 });
  });

  it('preserves int64 precision beyond Number.MAX_SAFE_INTEGER', async () => {
    server = await startServer((_req, res) => res.end());
    const options = clickhouseSinkOptions.parse({ url: server.url, database: 'd', table: 't' });
    const sink = await clickhouseSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    const bigValue = 9_223_372_036_854_775_800n;
    const event = new LogEvent(new Map([['big', bigValue]]));
    await harness.feed([event]);
    harness.close();
    await run;

    const raw = server.requests[0]!.body.toString('utf8').trim();
    expect(raw).toContain('9223372036854775800');
    expect(raw).not.toContain('.'); // never round-tripped through a float
  });

  it('appends configured settings as query parameters', async () => {
    server = await startServer((_req, res) => res.end());
    const options = clickhouseSinkOptions.parse({
      url: server.url,
      database: 'd',
      table: 't',
      settings: { async_insert: '1', wait_for_async_insert: '0' },
    });
    const sink = await clickhouseSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('x')]);
    harness.close();
    await run;
    const url = new URL(server.requests[0]!.url, 'http://x');
    expect(url.searchParams.get('async_insert')).toBe('1');
    expect(url.searchParams.get('wait_for_async_insert')).toBe('0');
  });

  it('maps fields to columns when `columns` is configured', async () => {
    server = await startServer((_req, res) => res.end());
    const options = clickhouseSinkOptions.parse({
      url: server.url,
      database: 'd',
      table: 't',
      columns: [
        { field: '.message', column: 'msg' },
        { field: '.http.status', column: 'status' },
      ],
    });
    const sink = await clickhouseSink.build(options, testBuildContext().ctx);
    const harness = createTestSinkContext();
    const run = sink.run(harness.ctx);
    await harness.feed([LogEvent.from({ message: 'hi', http: { status: 200 }, extra: 'dropped' })]);
    harness.close();
    await run;
    const row: unknown = JSON.parse(server.requests[0]!.body.toString('utf8').trim());
    expect(row).toEqual({ msg: 'hi', status: 200 });
  });
});
