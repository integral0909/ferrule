import {
  encodeJson,
  LogEvent,
  parseJson,
  utf8Encode,
  type DeliveryStatus,
  type Event,
  type Value,
} from '@ferrule/core';
import { stringifyValue } from '@ferrule/codecs';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink, SinkError } from '@ferrule/runtime';
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
import { buildRetryPolicy, clockDate, eventContext } from '../support.js';
import {
  compileFieldTemplate,
  formatTimePattern,
  type CompiledFieldTemplate,
} from '../templating.js';

export const elasticsearchSinkOptions = withZstdSupportCheck(
  transportSchema.extend({
    /** Elasticsearch base URL, e.g. `https://es.internal:9200`. */
    url: s.url({ protocols: ['http', 'https'] }),
    /** Index name template: `%Y.%m.%d`-style time tokens plus `{{ field }}` references, evaluated
     * per event (so one bulk request can span several resolved index names). */
    index: s.string().nonEmpty(),
    /** Field supplying the document `_id`. Omit to let Elasticsearch assign one. */
    id_field: s.fieldPath().optional(),
    action: s.enum(['index', 'create']).default('index'),
    /** Data-stream mode: forces the `create` action (data streams reject `index`) and treats
     * `index` as the data stream name. */
    data_stream: s.boolean().default(false),
    batch: batchSchema,
    retry: retrySchema,
    concurrency: concurrencySchema,
  }),
);
export type ElasticsearchSinkOptions = Infer<typeof elasticsearchSinkOptions>;

interface Encoded {
  readonly body: Uint8Array;
  readonly events: readonly Event[];
}

function statusFor(httpStatus: number): DeliveryStatus {
  if (httpStatus >= 200 && httpStatus < 300) return 'delivered';
  if (httpStatus === 429 || httpStatus >= 500) return 'errored';
  return 'rejected';
}

/** Parses `_bulk`'s response, returning one HTTP-style status per item in request order (or
 * `undefined` if the response doesn't have the expected shape). */
function parseBulkItemStatuses(body: Uint8Array): number[] | undefined {
  let value: Value;
  try {
    value = parseJson(Buffer.from(body).toString('utf8'));
  } catch {
    return undefined;
  }
  if (!(value instanceof Map)) return undefined;
  const items = value.get('items');
  if (!Array.isArray(items)) return undefined;
  const statuses: number[] = [];
  for (const item of items) {
    if (!(item instanceof Map) || item.size === 0) {
      statuses.push(500);
      continue;
    }
    const action = [...item.values()][0];
    const status = action instanceof Map ? action.get('status') : undefined;
    statuses.push(
      typeof status === 'bigint' ? Number(status) : typeof status === 'number' ? status : 500,
    );
  }
  return statuses;
}

/** Elasticsearch `_bulk` sink: one action line + one document line per event, with per-item
 * bulk-response errors resolved to each event's own delivery status (rather than the whole batch
 * succeeding or failing together). */
export const elasticsearchSink = defineSink<ElasticsearchSinkOptions>({
  kind: 'sink',
  type: 'elasticsearch',
  description: 'Writes events to Elasticsearch via the bulk API, one status per event.',
  options: elasticsearchSinkOptions,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Daily indices',
      config: { url: 'https://es.internal:9200', index: 'logs-%Y.%m.%d' },
    },
  ],
  build: (options, ctx) => {
    const indexTemplate: CompiledFieldTemplate = compileFieldTemplate(options.index);
    const action = options.data_stream ? 'create' : options.action;
    const bulkUrl = new URL('/_bulk', options.url).toString();

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

    function resolveIndex(event: Event, now: Date): string {
      const rendered = indexTemplate.render(eventContext(event));
      return formatTimePattern(rendered, now);
    }

    function resolveId(event: Event): string | undefined {
      if (options.id_field === undefined || !(event instanceof LogEvent)) return undefined;
      const value = event.get(options.id_field);
      return value === undefined ? undefined : stringifyValue(value);
    }

    function encode(events: Event[], now: Date): Encoded {
      const lines: Uint8Array[] = [];
      for (const event of events) {
        const meta: Record<string, unknown> = { _index: resolveIndex(event, now) };
        const id = resolveId(event);
        if (id !== undefined) meta['_id'] = id;
        lines.push(utf8Encode(JSON.stringify({ [action]: meta })));
        const doc = event instanceof LogEvent ? event.fields : eventContext(event);
        lines.push(utf8Encode(encodeJson(doc)));
      }
      return { body: frameChunks(lines, 'ndjson'), events };
    }

    return {
      async run(sinkCtx) {
        try {
          await runBatchedSink<Encoded>(sinkCtx, {
            ...(options.batch?.max_events !== undefined
              ? { maxEvents: options.batch.max_events }
              : {}),
            ...(options.batch?.max_size !== undefined ? { maxBytes: options.batch.max_size } : {}),
            timeoutMs: options.batch?.timeout ?? 1_000,
            encode: (events) => encode(events, clockDate(sinkCtx.clock)),
            send: async (payload) => {
              const response = await client.request({
                method: 'POST',
                url: bulkUrl,
                headers: { 'content-type': 'application/x-ndjson' },
                body: payload.body,
              });
              const topLevelError = ensureSuccess(response, 'E_ELASTICSEARCH_SINK');
              if (topLevelError !== undefined) throw topLevelError;
              const statuses = parseBulkItemStatuses(response.body);
              if (statuses === undefined || statuses.length !== payload.events.length) {
                throw SinkError.retryable(
                  'E_ELASTICSEARCH_BULK_SHAPE',
                  'bulk response did not include one item per request document',
                );
              }
              for (let i = 0; i < payload.events.length; i++) {
                payload.events[i]!.metadata.finalizers.finish(statusFor(statuses[i]!));
              }
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
