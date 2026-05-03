import { encodeJson, formatFloat, toHex, Timestamp, type Event } from '@ferrule/core';
import { stringifyValue } from '@ferrule/codecs';
import {
  defineSink,
  runBatchedSink,
  SinkError,
  type BuildContext,
  type Logger,
  type Sink,
  type SinkContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { batchSchema, buildRetryPolicy, retrySchema, tlsSchema } from '../fragments.js';
import { getEventField } from '../stream/template.js';
import { encodeCopyCsvRow, encodeCopyTextRow } from './copy-format.js';
import { PostgresError } from './errors.js';
import { PgPool, type PgPoolOptions } from './pool.js';

const columnTypeSchema = s.enum([
  'text',
  'integer',
  'bigint',
  'float',
  'boolean',
  'timestamp',
  'json',
  'bytes',
]);

export const postgresSinkOptionsSchema = s.object({
  host: s.string().nonEmpty(),
  port: s.integer({ min: 1, max: 65535 }).default(5432),
  database: s.string().nonEmpty(),
  user: s.string().nonEmpty(),
  password: s.string().secret().optional(),
  application_name: s.string().default('ferrule'),
  tls: tlsSchema,
  /** Table name, optionally schema-qualified (`"public.events"`). Quoted automatically. */
  table: s.string().nonEmpty(),
  /** Column mapping: destination column name, source event field, and its coercion type. */
  columns: s.array(
    s.object({
      name: s.string().nonEmpty(),
      field: s.fieldPath(),
      type: columnTypeSchema.default('text'),
    }),
    { minItems: 1 },
  ),
  copy_format: s.enum(['text', 'csv']).default('text'),
  max_connections: s.integer({ min: 1 }).default(5),
  connect_timeout: s.duration().default(10_000),
  /** Groups events into batches before running COPY. Default: 1000 events / 4MiB / 1s. */
  batch: batchSchema,
  /** On a permanent (constraint/data) error, bisect the batch to isolate and reject only the bad
   * row(s) instead of the whole batch. Default `true`. */
  bisect_on_failure: s.boolean().default(true),
  /** Retry backoff for connection and COPY failures. Default 250ms/30s. */
  retry: retrySchema,
});

export type PostgresSinkOptions = Infer<typeof postgresSinkOptionsSchema>;
type ColumnMapping = PostgresSinkOptions['columns'][number];

/** Quotes a PostgreSQL identifier, doubling embedded double quotes. A dotted name
 * (`schema.table`) has each segment quoted separately. */
export function quoteIdentifier(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.');
}

function buildCopySql(options: PostgresSinkOptions): string {
  const columns = options.columns.map((c) => quoteIdentifier(c.name)).join(', ');
  const format = options.copy_format === 'csv' ? 'CSV' : 'TEXT';
  return `COPY ${quoteIdentifier(options.table)} (${columns}) FROM STDIN WITH (FORMAT ${format})`;
}

/** Coerces one event's field value to the text representation `COPY` expects for `column.type`.
 * Missing or type-mismatched values become SQL `NULL` rather than throwing — bad data belongs to
 * one row and is caught (and rejected) by the server's own constraint/data-type checking, or by
 * bisection, not by crashing the whole batch here. */
export function coerceColumnValue(event: Event, column: ColumnMapping): string | null {
  const value = getEventField(event, column.field);
  if (value === undefined || value === null) return null;
  switch (column.type) {
    case 'text':
      return stringifyValue(value);
    case 'integer':
    case 'bigint':
      return typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'number'
          ? String(Math.trunc(value))
          : null;
    case 'float':
      return typeof value === 'number'
        ? formatFloat(value)
        : typeof value === 'bigint'
          ? value.toString()
          : null;
    case 'boolean':
      return typeof value === 'boolean' ? (value ? 'true' : 'false') : null;
    case 'timestamp':
      return value instanceof Timestamp ? value.toISOString() : null;
    case 'json':
      return encodeJson(value);
    case 'bytes':
      return value instanceof Uint8Array ? `\\x${toHex(value)}` : null;
  }
}

function buildPoolOptions(
  options: PostgresSinkOptions,
  overrides: { maxConnections: number; onNotice: PgPoolOptions['onNotice'] },
): PgPoolOptions {
  return {
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    ...(options.password !== undefined ? { password: options.password } : {}),
    applicationName: options.application_name,
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    connectTimeoutMs: options.connect_timeout,
    maxConnections: overrides.maxConnections,
    ...(overrides.onNotice !== undefined ? { onNotice: overrides.onNotice } : {}),
  };
}

function encodeRows(events: readonly Event[], options: PostgresSinkOptions): Buffer {
  const rows = events.map((event) =>
    options.columns.map((column) => coerceColumnValue(event, column)),
  );
  const text =
    options.copy_format === 'csv'
      ? rows.map((row) => encodeCopyCsvRow(row)).join('')
      : rows.map((row) => encodeCopyTextRow(row)).join('');
  return Buffer.from(text, 'utf8');
}

/**
 * Runs `COPY` for `events` on a pooled connection, bisecting on a permanent (constraint/data)
 * failure to isolate and reject only the offending row(s) instead of the whole batch. Finishes
 * every event's finalizers itself; callers must not finish them again.
 */
async function copyWithBisection(
  pool: PgPool,
  sql: string,
  events: readonly Event[],
  options: PostgresSinkOptions,
  logger: Logger,
): Promise<void> {
  try {
    await pool.withConnection((conn) => conn.copyFromStdin(sql, [encodeRows(events, options)]));
    for (const event of events) event.metadata.finalizers.finish('delivered');
    return;
  } catch (error) {
    if (!(error instanceof PostgresError) || error.isRetryable) throw error;
    if (!options.bisect_on_failure || events.length === 1) {
      logger.warn('postgres sink rejected a batch after a permanent error', {
        sqlState: error.sqlState,
        message: error.message,
        events: events.length,
      });
      for (const event of events) event.metadata.finalizers.finish('rejected');
      return;
    }
    const mid = Math.floor(events.length / 2);
    await copyWithBisection(pool, sql, events.slice(0, mid), options, logger);
    await copyWithBisection(pool, sql, events.slice(mid), options, logger);
  }
}

export function createPostgresSink(options: PostgresSinkOptions): Sink {
  const sql = buildCopySql(options);
  return {
    async run(ctx: SinkContext): Promise<void> {
      const pool = new PgPool(
        buildPoolOptions(options, {
          maxConnections: options.max_connections,
          onNotice: (notice) => ctx.logger.debug('postgres notice', { message: notice.message }),
        }),
      );
      try {
        await runBatchedSink(ctx, {
          maxEvents: options.batch?.max_events ?? 1_000,
          maxBytes: options.batch?.max_size ?? 4 * 1024 * 1024,
          timeoutMs: options.batch?.timeout ?? 1_000,
          send: async (events: Event[]) => {
            try {
              await copyWithBisection(pool, sql, events, options, ctx.logger);
            } catch (error) {
              if (error instanceof PostgresError) {
                if (error.isRetryable) {
                  throw SinkError.retryable('E_POSTGRES_RETRYABLE', error.message, {
                    cause: error,
                  });
                }
                throw SinkError.permanent('E_POSTGRES_PERMANENT', error.message, error);
              }
              throw SinkError.retryable(
                'E_POSTGRES_CONNECTION',
                error instanceof Error ? error.message : String(error),
                { cause: error },
              );
            }
          },
          retry: buildRetryPolicy(options.retry ?? { initial_backoff: 250, max_backoff: 30_000 }),
        });
      } finally {
        await pool.close();
      }
    },
    async healthcheck(ctx): Promise<void> {
      const pool = new PgPool(
        buildPoolOptions(options, { maxConnections: 1, onNotice: undefined }),
      );
      try {
        await pool.healthcheck();
      } finally {
        await pool.close();
      }
      void ctx;
    },
  };
}

export const postgresSink = defineSink({
  kind: 'sink',
  type: 'postgres',
  description:
    'Bulk-inserts events into a PostgreSQL table via COPY, over a hand-written wire protocol client.',
  options: postgresSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Insert logs into a table',
      config: {
        host: '127.0.0.1',
        database: 'telemetry',
        user: 'ferrule',
        table: 'logs',
        columns: [
          { name: 'ts', field: 'timestamp', type: 'timestamp' },
          { name: 'message', field: 'message', type: 'text' },
        ],
      },
    },
  ],
  build: (options: PostgresSinkOptions, _ctx: BuildContext) => createPostgresSink(options),
});
