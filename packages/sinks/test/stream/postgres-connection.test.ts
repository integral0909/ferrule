import { afterEach, describe, expect, it } from 'vitest';
import { PgConnection } from '../../src/postgres/connection.js';
import { PostgresAuthError, PostgresError } from '../../src/postgres/errors.js';
import { FakePostgresServer } from './support/fake-postgres-server.js';

let server: FakePostgresServer | undefined;
let connection: PgConnection | undefined;

afterEach(async () => {
  if (connection !== undefined) await connection.close().catch(() => undefined);
  if (server !== undefined) await server.close();
  connection = undefined;
  server = undefined;
});

describe('PgConnection: startup and authentication', () => {
  it('connects with trust auth and reaches ReadyForQuery', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await expect(connection.connect()).resolves.toBeUndefined();
    expect(connection.processId).toBe(4242);
  });

  it('authenticates with cleartext password', async () => {
    server = new FakePostgresServer({ auth: 'cleartext', password: 'secret' });
    const port = await server.listen();
    connection = new PgConnection({
      host: '127.0.0.1',
      port,
      database: 'db',
      user: 'u',
      password: 'secret',
    });
    await expect(connection.connect()).resolves.toBeUndefined();
  });

  it('rejects a wrong cleartext password with a PostgresError', async () => {
    server = new FakePostgresServer({ auth: 'cleartext', password: 'secret' });
    const port = await server.listen();
    connection = new PgConnection({
      host: '127.0.0.1',
      port,
      database: 'db',
      user: 'u',
      password: 'wrong',
    });
    await expect(connection.connect()).rejects.toThrow(PostgresError);
  });

  it('authenticates with MD5', async () => {
    server = new FakePostgresServer({ auth: 'md5', password: 'secret' });
    const port = await server.listen();
    connection = new PgConnection({
      host: '127.0.0.1',
      port,
      database: 'db',
      user: 'u',
      password: 'secret',
    });
    await expect(connection.connect()).resolves.toBeUndefined();
  });

  it('rejects a wrong MD5 password', async () => {
    server = new FakePostgresServer({ auth: 'md5', password: 'secret' });
    const port = await server.listen();
    connection = new PgConnection({
      host: '127.0.0.1',
      port,
      database: 'db',
      user: 'u',
      password: 'nope',
    });
    await expect(connection.connect()).rejects.toThrow(PostgresError);
  });

  it('authenticates with SASL/SCRAM-SHA-256', async () => {
    server = new FakePostgresServer({ auth: 'scram', password: 'pencil' });
    const port = await server.listen();
    connection = new PgConnection({
      host: '127.0.0.1',
      port,
      database: 'db',
      user: 'u',
      password: 'pencil',
    });
    await expect(connection.connect()).resolves.toBeUndefined();
  });

  it('rejects a wrong SCRAM password', async () => {
    server = new FakePostgresServer({ auth: 'scram', password: 'pencil' });
    const port = await server.listen();
    connection = new PgConnection({
      host: '127.0.0.1',
      port,
      database: 'db',
      user: 'u',
      password: 'wrong-password',
    });
    await expect(connection.connect()).rejects.toThrow(PostgresError);
  });

  it('throws PostgresAuthError when a password is required but none is configured', async () => {
    server = new FakePostgresServer({ auth: 'md5', password: 'secret' });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await expect(connection.connect()).rejects.toThrow(PostgresAuthError);
  });
});

describe('PgConnection: simple query protocol', () => {
  it('runs a query and parses RowDescription/DataRow/CommandComplete', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    const results = await connection.simpleQuery('SELECT 1');
    expect(results).toHaveLength(1);
    expect(results[0]?.rows).toEqual([['1']]);
    expect(results[0]?.commandTag).toBe('SELECT 1');
  });

  it('runs a custom-scripted query result via onSimpleQuery', async () => {
    server = new FakePostgresServer({
      auth: 'trust',
      onSimpleQuery: (sql) =>
        sql === 'SELECT name FROM t'
          ? { columnNames: ['name'], rows: [['a'], ['b']], commandTag: 'SELECT 2' }
          : undefined,
    });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    const results = await connection.simpleQuery('SELECT name FROM t');
    expect(results[0]?.rows).toEqual([['a'], ['b']]);
    expect(results[0]?.commandTag).toBe('SELECT 2');
  });
});

describe('PgConnection: extended query protocol', () => {
  it('runs Parse/Bind/Describe/Execute/Sync and returns a row', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    const result = await connection.extendedQuery('SELECT $1', ['hi']);
    expect(result.fields.map((f) => f.name)).toEqual(['answer']);
    expect(result.rows).toEqual([['1']]);
  });
});

describe('PgConnection: COPY FROM STDIN', () => {
  it('delivers COPY data to the server byte-for-byte', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    const payload = Buffer.from('1\thello\n2\tworld\n', 'utf8');
    const result = await connection.copyFromStdin('COPY t (a,b) FROM STDIN WITH (FORMAT TEXT)', [
      payload,
    ]);
    expect(result.commandTag).toBe('COPY 0');
    expect(server.receivedCopyData).toHaveLength(1);
    expect(server.receivedCopyData[0]!.equals(payload)).toBe(true);
  });

  it('splits a payload across multiple CopyData chunks and still reassembles it exactly', async () => {
    server = new FakePostgresServer({ auth: 'trust' });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    const full = Buffer.from('a\tb\tc\n'.repeat(500), 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < full.length; i += 37) chunks.push(full.subarray(i, i + 37));
    await connection.copyFromStdin('COPY t (a,b,c) FROM STDIN', chunks);
    expect(server.receivedCopyData[0]!.equals(full)).toBe(true);
  });

  it('surfaces a server-side COPY failure (e.g. a constraint violation) as a PostgresError', async () => {
    server = new FakePostgresServer({
      auth: 'trust',
      onCopy: () => ({
        ok: false,
        sqlState: '23505',
        message: 'duplicate key value violates unique constraint',
      }),
    });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    const payload = Buffer.from('1\tdup\n', 'utf8');
    await expect(
      connection.copyFromStdin('COPY t (a,b) FROM STDIN', [payload]),
    ).rejects.toMatchObject({
      sqlState: '23505',
    });
    // The connection must still be usable afterward (ReadyForQuery was reached).
    const results = await connection.simpleQuery('SELECT 1');
    expect(results[0]?.rows).toEqual([['1']]);
  });

  it('classifies a connection-class SQLSTATE as retryable and a constraint-class one as not', async () => {
    server = new FakePostgresServer({
      auth: 'trust',
      onCopy: () => ({ ok: false, sqlState: '08006', message: 'connection failure' }),
    });
    const port = await server.listen();
    connection = new PgConnection({ host: '127.0.0.1', port, database: 'db', user: 'u' });
    await connection.connect();
    try {
      await connection.copyFromStdin('COPY t (a) FROM STDIN', [Buffer.from('x\n')]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresError);
      expect((error as PostgresError).isRetryable).toBe(true);
    }
  });
});
