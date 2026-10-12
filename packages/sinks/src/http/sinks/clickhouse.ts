import {
  encodeJson,
  FerruleError,
  getPath,
  LogEvent,
  utf8Encode,
  type Event,
  type Path,
  type ValueMap,
} from '@ferrule/core';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { HttpClient, ensureSuccess } from '../client.js';
import { frameChunks } from '../framing.js';
import {
  batchSchema,
  concurrencySchema,
  retrySchema,
  transportSchema,
  withZstdSupportCheck,
} from '../schema.js';
import { buildRetryPolicy, eventContext } from '../support.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validates and backtick-quotes a ClickHouse identifier (database, table, or column name).
 * Rejects anything outside `[A-Za-z_][A-Za-z0-9_]*` rather than attempting to escape it, since an
 * identifier here always comes from configuration, not event data. */
export function quoteClickHouseIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new FerruleError(
      'E_CLICKHOUSE_IDENTIFIER',
      `invalid ClickHouse identifier ${JSON.stringify(name)}: must match [A-Za-z_][A-Za-z0-9_]*`,
    );
  }
  return `\`${name}\``;
}

const columnMappingSchema = s.array(
  s.object({ field: s.fieldPath(), column: s.string().nonEmpty() }),
);

export const clickhouseSinkOptions = withZstdSupportCheck(
  transportSchema.extend({
    /** ClickHouse HTTP interface base URL, e.g. `http://clickhouse:8123`. */
    url: s.url({ protocols: ['http', 'https'] }),
    database: s.string().nonEmpty(),
    table: s.string().nonEmpty(),
    /** Explicit field -> column mapping. Defaults to passing every top-level field through under
     * its own name. */
    columns: columnMappingSchema.optional(),
    /** Extra ClickHouse HTTP settings sent as query parameters, e.g. `{ async_insert: "1" }`. */
    settings: s.record(s.string()).optional(),
    batch: batchSchema,
    retry: retrySchema,
    concurrency: concurrencySchema,
  }),
);
export type ClickhouseSinkOptions = Infer<typeof clickhouseSinkOptions>;

function buildRow(
  event: Event,
  columns: readonly { field: Path; column: string }[] | undefined,
): ValueMap {
  const fields = event instanceof LogEvent ? event.fields : eventContext(event);
  if (columns === undefined) return fields;
  const row: ValueMap = new Map();
  for (const { field, column } of columns) {
    const value = getPath(fields, field);
    if (value !== undefined) row.set(column, value);
  }
  return row;
}

/** ClickHouse HTTP-interface sink: `INSERT INTO db.table FORMAT JSONEachRow`. Int64 columns keep
 * full precision because rows are encoded with core's lossless JSON encoder (bigints are written
 * as exact integer literals, never routed through a float64). */
export const clickhouseSink = defineSink<ClickhouseSinkOptions>({
  kind: 'sink',
  type: 'clickhouse',
  description: 'Inserts events into ClickHouse via its HTTP interface (JSONEachRow).',
  options: clickhouseSinkOptions,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Insert events into a ClickHouse table',
      config: {
        url: 'http://clickhouse.internal:8123',
        database: 'telemetry',
        table: 'logs',
      },
    },
  ],
  build: (options, ctx) => {
    const database = quoteClickHouseIdentifier(options.database);
    const table = quoteClickHouseIdentifier(options.table);
    const query = `INSERT INTO ${database}.${table} FORMAT JSONEachRow`;
    const insertUrl = new URL(options.url);
    insertUrl.searchParams.set('query', query);
    for (const [key, value] of options.settings ?? new Map<string, string>()) {
      insertUrl.searchParams.set(key, value);
    }
    const url = insertUrl.toString();

    const client = new HttpClient({
      auth: options.auth,
      tls: options.tls,
      proxy: options.proxy,
      timeoutMs: options.timeout,
      maxResponseBytes: options.max_response_size,
      compression: options.compression,
      headers: options.headers,
      maxSockets: options.max_sockets,
      logger: ctx.logger,
    });

    return {
      async run(sinkCtx) {
        try {
          await runBatchedSink(sinkCtx, {
            ...(options.batch?.max_events !== undefined
              ? { maxEvents: options.batch.max_events }
              : {}),
            ...(options.batch?.max_size !== undefined ? { maxBytes: options.batch.max_size } : {}),
            timeoutMs: options.batch?.timeout ?? 1_000,
            encode: (events) =>
              frameChunks(
                events.map((event) => {
                  const row = buildRow(event, options.columns);
                  return utf8Encode(encodeJson(row));
                }),
                'ndjson',
              ),
            send: async (body) => {
              const response = await client.request({
                method: 'POST',
                url,
                headers: { 'content-type': 'application/x-ndjson' },
                body,
              });
              const error = ensureSuccess(response, 'E_CLICKHOUSE_SINK');
              if (error !== undefined) throw error;
            },
            retry: buildRetryPolicy(options.retry),
            concurrency: new FixedConcurrencyLimiter(options.concurrency),
          });
        } finally {
          client.close();
        }
      },
    };
  },
});
