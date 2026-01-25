import {
  encodeJson,
  fromPlain,
  FerruleError,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  utf8Encode,
  type Event,
} from '@ferrule/core';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { HttpClient, ensureSuccess } from '../client.js';
import { batchSchema, concurrencySchema, retrySchema, transportSchema } from '../schema.js';
import { buildRetryPolicy, eventContext } from '../support.js';
import { compileFieldTemplate, type CompiledFieldTemplate } from '../templating.js';

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const lokiSinkOptions = transportSchema.extend({
  /** Loki's base URL, e.g. `https://loki.internal:3100`. */
  url: s.url({ protocols: ['http', 'https'] }),
  pushPath: s.string().default('/loki/api/v1/push'),
  /** Sent as `X-Scope-OrgID` for multi-tenant Loki deployments. */
  tenant: s.string().optional(),
  /** Stream labels, as `name -> {{ field.path }}` templates. Label names must match
   * `[a-zA-Z_][a-zA-Z0-9_]*`. */
  labels: s.record(s.string()),
  /** Template for the log line. Defaults to `.message` (or the whole event as JSON if absent). */
  line: s.string().optional(),
  /** Field holding a `Timestamp` to use as the entry's time. Defaults to when Ferrule received it. */
  timestampField: s.fieldPath().optional(),
  /** `sort` (default) sorts entries within a stream ascending by timestamp before sending, since
   * Loki (without out-of-order ingestion enabled) rejects a decreasing timestamp within a stream.
   * `passthrough` sends entries in arrival order and lets Loki apply its own policy. */
  outOfOrder: s.enum(['sort', 'passthrough']).default('sort'),
  /** Caps the number of distinct label combinations (streams) this sink will track; events for a
   * new combination beyond the cap are rejected rather than accepted into an unbounded set of
   * streams. */
  maxStreams: s.integer({ min: 1 }).default(10_000),
  batch: batchSchema.optional(),
  retry: retrySchema.optional(),
  concurrency: concurrencySchema,
});
export type LokiSinkOptions = Infer<typeof lokiSinkOptions>;

interface LokiPayload {
  readonly labels: Readonly<Record<string, string>>;
  readonly values: readonly (readonly [string, string])[];
}

/** Loki-compatible push API sink (`POST /loki/api/v1/push`, JSON form). */
export const lokiSink = defineSink<LokiSinkOptions>({
  kind: 'sink',
  type: 'loki',
  description: 'Pushes log lines to a Loki-compatible push API, partitioned by label set.',
  options: lokiSinkOptions,
  accepts: ['log', 'metric', 'span'],
  build: (options, ctx) => {
    const labelTemplates = new Map<string, CompiledFieldTemplate>();
    for (const [name, template] of options.labels) {
      if (!LABEL_NAME.test(name)) {
        throw new FerruleError(
          'E_LOKI_BAD_LABEL',
          `invalid Loki label name ${JSON.stringify(name)}`,
        );
      }
      labelTemplates.set(name, compileFieldTemplate(template));
    }
    const lineTemplate =
      options.line !== undefined ? compileFieldTemplate(options.line) : undefined;
    const timestampField = options.timestampField;
    const seenStreams = new Set<string>();
    const pushUrl = new URL(options.pushPath, options.url).toString();

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

    function labelsFor(event: Event): Record<string, string> {
      const context = eventContext(event);
      const out: Record<string, string> = {};
      for (const [name, template] of labelTemplates) out[name] = template.render(context);
      return out;
    }

    function lineFor(event: Event): string {
      if (lineTemplate !== undefined) return lineTemplate.render(eventContext(event));
      if (event instanceof LogEvent) {
        const message = event.get('message');
        if (typeof message === 'string') return message;
        return encodeJson(event.fields);
      }
      if (event instanceof MetricEvent) {
        return encodeJson(
          fromPlain({
            name: event.name,
            tags: Object.fromEntries(event.tags),
            kind: event.metricKind,
          }),
        );
      }
      return encodeJson(
        fromPlain({ name: event.name, traceId: event.traceIdHex, spanId: event.spanIdHex }),
      );
    }

    function timestampNanos(event: Event): string {
      let ts: Timestamp | undefined;
      if (timestampField !== undefined && event instanceof LogEvent) {
        const value = event.get(timestampField);
        if (value instanceof Timestamp) ts = value;
      } else if (event instanceof MetricEvent) {
        ts = event.timestamp;
      } else if (event instanceof SpanEvent) {
        ts = event.startTime;
      }
      return (ts ?? event.metadata.receivedAt).nanos.toString();
    }

    function streamSignature(labels: Readonly<Record<string, string>>): string {
      return Object.entries(labels)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}\u0000${v}`)
        .join('\u0001');
    }

    return {
      async run(sinkCtx) {
        try {
          await runBatchedSink<LokiPayload | undefined>(sinkCtx, {
            ...(options.batch?.maxEvents !== undefined
              ? { maxEvents: options.batch.maxEvents }
              : {}),
            ...(options.batch?.maxBytes !== undefined ? { maxBytes: options.batch.maxBytes } : {}),
            timeoutMs: options.batch?.timeout ?? 1_000,
            partitionKey: (event) => streamSignature(labelsFor(event)),
            encode: (events) => {
              const labels = labelsFor(events[0]!);
              const signature = streamSignature(labels);
              if (!seenStreams.has(signature)) {
                if (seenStreams.size >= options.maxStreams) {
                  ctx.logger.warn('loki: label-cardinality limit reached; rejecting new stream', {
                    labels,
                    limit: options.maxStreams,
                  });
                  for (const event of events) event.metadata.finalizers.finish('rejected');
                  return undefined;
                }
                seenStreams.add(signature);
              }
              const values: [string, string][] = events.map((event) => [
                timestampNanos(event),
                lineFor(event),
              ]);
              if (options.outOfOrder === 'sort') {
                values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
              }
              return { labels, values };
            },
            send: async (payload) => {
              if (payload === undefined) return;
              const body = utf8Encode(
                JSON.stringify({ streams: [{ stream: payload.labels, values: payload.values }] }),
              );
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              if (options.tenant !== undefined) headers['x-scope-orgid'] = options.tenant;
              const response = await client.request({
                method: 'POST',
                url: pushUrl,
                headers,
                body,
              });
              const error = ensureSuccess(response, 'E_LOKI_SINK');
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
