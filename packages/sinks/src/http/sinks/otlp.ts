import { defaultCodecs } from '@ferrule/codecs';
import { ProtoReader, WireType } from '@ferrule/codecs';
import { parseJson, type Event, type EventKind } from '@ferrule/core';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { HttpClient, ensureSuccess } from '../client.js';
import {
  batchSchema,
  concurrencySchema,
  retrySchema,
  transportSchema,
  withZstdSupportCheck,
} from '../schema.js';
import { buildRetryPolicy } from '../support.js';

export type OtlpSignal = 'logs' | 'metrics' | 'traces';

const DEFAULT_PATHS: Record<OtlpSignal, string> = {
  logs: '/v1/logs',
  metrics: '/v1/metrics',
  traces: '/v1/traces',
};

const SIGNAL_KIND: Record<OtlpSignal, EventKind> = {
  logs: 'log',
  metrics: 'metric',
  traces: 'span',
};

export const otlpSinkOptions = withZstdSupportCheck(
  transportSchema.extend({
    /** OTLP/HTTP collector base URL, e.g. `http://collector:4318`. */
    endpoint: s.url({ protocols: ['http', 'https'] }),
    signal: s.enum(['logs', 'metrics', 'traces']).default('logs'),
    protocol: s.enum(['protobuf', 'json']).default('protobuf'),
    /** Overrides the standard per-signal path (`/v1/logs`, `/v1/metrics`, `/v1/traces`). */
    path: s.string().optional(),
    batch: batchSchema,
    retry: retrySchema,
    concurrency: concurrencySchema,
  }),
);
export type OtlpSinkOptions = Infer<typeof otlpSinkOptions>;

interface PartialSuccess {
  readonly rejected: bigint;
  readonly errorMessage: string;
}

/** Decodes the `partial_success` field (submessage 1, `{ rejected_* = 1 (int64), error_message =
 * 2 (string) }`, identical shape across all three OTLP export responses) out of an OTLP/HTTP
 * protobuf response body. Returns `undefined` for an empty body or one with no `partial_success`. */
function decodePartialSuccessProtobuf(body: Uint8Array): PartialSuccess | undefined {
  if (body.byteLength === 0) return undefined;
  let result: PartialSuccess | undefined;
  const reader = new ProtoReader(body);
  while (!reader.atEnd()) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WireType.LengthDelimited) {
      const inner = reader.subReader();
      let rejected = 0n;
      let errorMessage = '';
      while (!inner.atEnd()) {
        const tag = inner.readTag();
        if (tag.field === 1 && tag.wireType === WireType.Varint) rejected = inner.readInt64();
        else if (tag.field === 2 && tag.wireType === WireType.LengthDelimited) {
          errorMessage = inner.readString();
        } else inner.skipValue(tag.wireType);
      }
      result = { rejected, errorMessage };
    } else {
      reader.skipValue(wireType);
    }
  }
  return result;
}

function decodePartialSuccessJson(body: Uint8Array): PartialSuccess | undefined {
  if (body.byteLength === 0) return undefined;
  try {
    const value = parseJson(Buffer.from(body).toString('utf8'));
    if (!(value instanceof Map)) return undefined;
    const partial = value.get('partialSuccess') ?? value.get('partial_success');
    if (!(partial instanceof Map)) return undefined;
    const rejectedField =
      partial.get('rejectedLogRecords') ??
      partial.get('rejected_log_records') ??
      partial.get('rejectedDataPoints') ??
      partial.get('rejected_data_points') ??
      partial.get('rejectedSpans') ??
      partial.get('rejected_spans');
    const rejected =
      typeof rejectedField === 'bigint'
        ? rejectedField
        : typeof rejectedField === 'string'
          ? BigInt(rejectedField)
          : 0n;
    const message = partial.get('errorMessage') ?? partial.get('error_message');
    return { rejected, errorMessage: typeof message === 'string' ? message : '' };
  } catch {
    return undefined;
  }
}

/** OTLP/HTTP exporter for one signal (logs, metrics, or traces), protobuf or JSON. A 2xx response
 * is treated as delivered per the OTLP spec even when it carries a `partial_success` — that field
 * is informational (the server accepted the batch but dropped some items); a non-empty
 * `error_message` is logged, but only a non-2xx HTTP status is treated as a delivery failure. */
export const otlpSink = defineSink<OtlpSinkOptions>({
  kind: 'sink',
  type: 'otlp',
  description: 'Exports events to an OTLP/HTTP collector (logs, metrics, or traces).',
  options: otlpSinkOptions,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Forward traces to another OTLP collector',
      config: { endpoint: 'http://otel-collector.internal:4318', signal: 'traces' },
    },
  ],
  build: (options, ctx) => {
    const signal = options.signal;
    const kind = SIGNAL_KIND[signal];
    const codecName = options.protocol === 'protobuf' ? 'otlp_protobuf' : 'otlp_json';
    const encoder = defaultCodecs.createEncoder(codecName, { signal });
    const contentType =
      options.protocol === 'protobuf' ? 'application/x-protobuf' : 'application/json';
    const url = new URL(options.path ?? DEFAULT_PATHS[signal], options.endpoint).toString();

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
          await runBatchedSink<Uint8Array | undefined>(sinkCtx, {
            ...(options.batch?.max_events !== undefined
              ? { maxEvents: options.batch.max_events }
              : {}),
            ...(options.batch?.max_size !== undefined ? { maxBytes: options.batch.max_size } : {}),
            timeoutMs: options.batch?.timeout ?? 1_000,
            encode: (events: Event[]) => {
              const matched: Event[] = [];
              for (const event of events) {
                if (event.kind === kind) matched.push(event);
                else event.metadata.finalizers.finish('rejected');
              }
              if (matched.length === 0) return undefined;
              return encoder.encodeBatch?.(matched) ?? encoder.encode(matched[0]!);
            },
            send: async (body) => {
              if (body === undefined) return;
              const response = await client.request({
                method: 'POST',
                url,
                headers: { 'content-type': contentType },
                body,
              });
              const error = ensureSuccess(response, 'E_OTLP_SINK');
              if (error !== undefined) throw error;
              const partial =
                options.protocol === 'protobuf'
                  ? decodePartialSuccessProtobuf(response.body)
                  : decodePartialSuccessJson(response.body);
              if (partial !== undefined && partial.rejected > 0n) {
                ctx.logger.warn('otlp: collector reported a partial success', {
                  signal,
                  rejected: partial.rejected.toString(),
                  errorMessage: partial.errorMessage,
                });
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
