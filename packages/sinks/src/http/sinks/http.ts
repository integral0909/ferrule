import { defaultCodecs } from '@ferrule/codecs';
import type { Event } from '@ferrule/core';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { HttpClient, ensureSuccess } from '../client.js';
import { contentTypeFor, frameChunks, type BatchFraming } from '../framing.js';
import { batchSchema, retrySchema, transportSchema, concurrencySchema } from '../schema.js';
import { buildRetryPolicy, eventContext } from '../support.js';
import { compileFieldTemplate, encodeUriValue } from '../templating.js';

export const httpSinkOptions = transportSchema.extend({
  /** Destination URL. Supports `{{ field.path }}` templating from the first event of each batch. */
  url: s.string().nonEmpty(),
  method: s.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  /** Codec used to encode each event; see `@ferrule/codecs`' registry for the full set. */
  codec: s.enum(['json', 'ndjson', 'text', 'logfmt']).default('ndjson'),
  /** How per-event encoded chunks are joined into one request body. */
  framing: s.enum(['ndjson', 'json_array', 'newline']).default('ndjson'),
  contentType: s.string().optional(),
  batch: batchSchema.optional(),
  retry: retrySchema.optional(),
  concurrency: concurrencySchema,
});
export type HttpSinkOptions = Infer<typeof httpSinkOptions>;

interface Encoded {
  readonly url: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** Generic HTTP(S) sink: batches events, encodes them with a named codec, frames the batch, and
 * `PUT`/`POST`s it to a (optionally field-templated) URL. */
export const httpSink = defineSink<HttpSinkOptions>({
  kind: 'sink',
  type: 'http',
  description: 'Delivers batches of events to an HTTP(S) endpoint.',
  options: httpSinkOptions,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Webhook',
      config: { url: 'https://example.com/ingest', method: 'POST', codec: 'ndjson' },
    },
  ],
  build: (options, ctx) => {
    const urlTemplate = compileFieldTemplate(options.url);
    const encoder = defaultCodecs.createEncoder(options.codec);
    const framing: BatchFraming = options.framing;
    const contentType = options.contentType ?? contentTypeFor(framing);
    const client = new HttpClient({
      auth: options.auth,
      tls: options.tls,
      proxy: options.proxy,
      timeoutMs: options.timeout,
      maxResponseBytes: options.maxResponseBytes,
      compression: options.compression,
      headers: options.headers,
      maxSockets: options.maxSockets,
      logger: ctx.logger,
    });

    function encode(events: Event[]): Encoded {
      const chunks = events.map((event) => encoder.encode(event));
      const url = urlTemplate.render(eventContext(events[0]!), encodeUriValue);
      return { url, body: frameChunks(chunks, framing), contentType };
    }

    return {
      async run(sinkCtx) {
        try {
          await runBatchedSink(sinkCtx, {
            ...(options.batch?.maxEvents !== undefined
              ? { maxEvents: options.batch.maxEvents }
              : {}),
            ...(options.batch?.maxBytes !== undefined ? { maxBytes: options.batch.maxBytes } : {}),
            timeoutMs: options.batch?.timeout ?? 1_000,
            encode,
            send: async (payload) => {
              const response = await client.request({
                method: options.method,
                url: payload.url,
                headers: { 'content-type': payload.contentType },
                body: payload.body,
              });
              const error = ensureSuccess(response, 'E_HTTP_SINK');
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
