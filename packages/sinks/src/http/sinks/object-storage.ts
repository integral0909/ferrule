import { randomBytes } from 'node:crypto';
import { LogEvent, MetricEvent, SpanEvent, Timestamp, type Event } from '@ferrule/core';
import { defaultCodecs } from '@ferrule/codecs';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink, type Clock } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { encodingSchema, splitCodecOptions } from '../../fragments.js';
import { HttpClient, ensureSuccess } from '../client.js';
import { contentTypeFor, frameChunks, type BatchFraming } from '../framing.js';
import { batchSchema, concurrencySchema, retrySchema, transportSchemaNoAuth } from '../schema.js';
import { buildRetryPolicy, clockDate, eventContext } from '../support.js';
import { sha256Hex, signV4, uriEncodePath } from '../sigv4.js';
import { compileFieldTemplate, formatTimePattern } from '../templating.js';

export const objectStorageSinkOptions = transportSchemaNoAuth.extend({
  /** S3-compatible endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or `http://localhost:9000`. */
  endpoint: s.url({ protocols: ['http', 'https'] }),
  bucket: s.string().nonEmpty(),
  /** Object key template: `%Y/%m/%d/%H`-style time tokens plus `{{ field }}` references. A random
   * suffix is always appended so concurrent batches never collide. */
  key: s.string().default('%Y/%m/%d/%H/events'),
  region: s.string().default('us-east-1'),
  service: s.string().default('s3'),
  addressing: s.enum(['path', 'virtual']).default('path'),
  access_key_id: s.string().secret(),
  secret_access_key: s.string().secret(),
  session_token: s.string().secret().optional(),
  /** Whether the key template's time tokens use the batch-flush wall clock, or the first event's
   * own timestamp. */
  time_source: s.enum(['batch', 'event']).default('batch'),
  /** Codec used to encode each event; see `@ferrule/codecs`' registry for the full set. */
  encoding: encodingSchema('ndjson'),
  framing: s.enum(['ndjson', 'json_array', 'newline']).default('ndjson'),
  content_type: s.string().optional(),
  batch: batchSchema,
  retry: retrySchema,
  concurrency: concurrencySchema,
});
export type ObjectStorageSinkOptions = Infer<typeof objectStorageSinkOptions>;

interface Encoded {
  readonly key: string;
  readonly body: Uint8Array;
}

function eventTime(event: Event): Date {
  if (event instanceof LogEvent) {
    const ts = event.get('timestamp');
    if (ts instanceof Timestamp) return ts.toDate();
  } else if (event instanceof MetricEvent && event.timestamp !== undefined) {
    return event.timestamp.toDate();
  } else if (event instanceof SpanEvent) {
    return event.startTime.toDate();
  }
  return event.metadata.receivedAt.toDate();
}

function appendUniqueSuffix(key: string): string {
  const suffix = randomBytes(6).toString('hex');
  const lastSlash = key.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : key.slice(0, lastSlash + 1);
  const base = lastSlash === -1 ? key : key.slice(lastSlash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0
    ? `${dir}${base}-${suffix}`
    : `${dir}${base.slice(0, dot)}-${suffix}${base.slice(dot)}`;
}

/** S3-compatible object storage sink: batches are PUT as objects, signed with a hand-written AWS
 * Signature Version 4 (header-based). Object keys combine time partitioning, event field
 * references, and a random unique suffix so retries and concurrent batches never collide. */
export const objectStorageSink = defineSink<ObjectStorageSinkOptions>({
  kind: 'sink',
  type: 'object_storage',
  description: 'Writes batches of events as objects to an S3-compatible store, SigV4-signed.',
  options: objectStorageSinkOptions,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Write NDJSON objects to an S3 bucket',
      config: {
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        bucket: 'ferrule-events',
        access_key_id: '${secret:AWS_ACCESS_KEY_ID}',
        secret_access_key: '${secret:AWS_SECRET_ACCESS_KEY}',
      },
    },
  ],
  build: (options, ctx) => {
    const endpoint = new URL(options.endpoint);
    const [codec, codecOptions] = splitCodecOptions(options.encoding);
    const encoder = defaultCodecs.createEncoder(codec, codecOptions);
    const framing: BatchFraming = options.framing;
    const contentType = options.content_type ?? contentTypeFor(framing);
    const gzip = options.compression === 'gzip';
    const keyHasTemplate = /\{\{/.test(options.key);

    const client = new HttpClient({
      tls: options.tls,
      proxy: options.proxy,
      timeoutMs: options.timeout,
      maxResponseBytes: options.max_response_size,
      compression: options.compression,
      headers: options.headers,
      maxSockets: options.max_sockets,
      logger: ctx.logger,
    });

    function renderKey(events: readonly Event[], clock: Clock): string {
      const representative = options.time_source === 'event' ? events[0]! : undefined;
      const date = representative !== undefined ? eventTime(representative) : clockDate(clock);
      let key = formatTimePattern(options.key, date);
      if (keyHasTemplate) key = compileFieldTemplate(key).render(eventContext(events[0]!));
      key = appendUniqueSuffix(key);
      return gzip && !key.endsWith('.gz') ? `${key}.gz` : key;
    }

    function requestUrl(key: string): URL {
      const encodedKey = uriEncodePath(key);
      if (options.addressing === 'path') {
        return new URL(`/${uriEncodePath(options.bucket)}/${encodedKey}`, endpoint);
      }
      return new URL(`${endpoint.protocol}//${options.bucket}.${endpoint.host}/${encodedKey}`);
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
            encode: (events) => ({
              key: renderKey(events, sinkCtx.clock),
              body: frameChunks(
                events.map((event) => encoder.encode(event)),
                framing,
              ),
            }),
            send: async (payload) => {
              const url = requestUrl(payload.key);
              const bodyHash = sha256Hex(payload.body);
              const signed = signV4({
                method: 'PUT',
                canonicalUri: url.pathname,
                headers: { host: url.host },
                payloadHash: bodyHash,
                region: options.region,
                service: options.service,
                date: sinkCtx.clock.now().toDate(),
                credentials: {
                  accessKeyId: options.access_key_id,
                  secretAccessKey: options.secret_access_key,
                  ...(options.session_token !== undefined
                    ? { sessionToken: options.session_token }
                    : {}),
                },
              });
              const headers: Record<string, string> = {
                'content-type': contentType,
                'x-amz-date': signed.amzDate,
                'x-amz-content-sha256': bodyHash,
                authorization: signed.authorizationHeader,
              };
              if (options.session_token !== undefined) {
                headers['x-amz-security-token'] = options.session_token;
              }
              const response = await client.request({
                method: 'PUT',
                url: url.toString(),
                headers,
                body: payload.body,
              });
              const error = ensureSuccess(response, 'E_OBJECT_STORAGE_SINK');
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
