import { MetricEvent, type Event } from '@ferrule/core';
import { defineSink, FixedConcurrencyLimiter, runBatchedSink } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { HttpClient, ensureSuccess } from '../client.js';
import {
  encodeWriteRequest,
  expandMetricToSeries,
  MetricAccumulator,
  UnsupportedMetricTypeError,
  type RemoteWriteSeries,
} from '../prom-remote-write.js';
import { batchSchema, concurrencySchema, retrySchema, transportSchema } from '../schema.js';
import { buildRetryPolicy } from '../support.js';
import { snappyCompress } from '../snappy.js';

export const prometheusRemoteWriteSinkOptions = transportSchema.extend({
  /** The remote-write endpoint, e.g. `http://prometheus:9090/api/v1/write`. */
  url: s.url({ protocols: ['http', 'https'] }),
  /** How long a series may go unobserved before the next sample restarts its running total
   * instead of adding to a now-stale one. */
  staleBound: s.duration({ minMs: 1 }).default(5 * 60_000),
  batch: batchSchema.optional(),
  retry: retrySchema.optional(),
  concurrency: concurrencySchema,
});
export type PrometheusRemoteWriteSinkOptions = Infer<typeof prometheusRemoteWriteSinkOptions>;

/** Prometheus remote-write sink: converts counters/gauges/histograms/summaries into
 * `prompb.WriteRequest` time series (accumulating `incremental` metrics into the absolute totals
 * the wire protocol carries), encodes the protobuf with the codecs package's `ProtoWriter`, and
 * compresses it with a hand-written Snappy block-format compressor — the protocol's mandatory
 * framing, for which no third-party dependency is available here. */
export const prometheusRemoteWriteSink = defineSink<PrometheusRemoteWriteSinkOptions>({
  kind: 'sink',
  type: 'prometheus_remote_write',
  description: 'Writes metrics to a Prometheus remote-write endpoint.',
  options: prometheusRemoteWriteSinkOptions,
  accepts: ['metric'],
  build: (options, ctx) => {
    const accumulator = new MetricAccumulator(options.staleBound);
    const client = new HttpClient({
      auth: options.auth,
      tls: options.tls,
      proxy: options.proxy,
      timeoutMs: options.timeout,
      maxResponseBytes: options.maxResponseBytes,
      // Remote write mandates Snappy-compressed protobuf; this sink compresses the body itself
      // rather than delegating to the client's generic (gzip-only) request compression.
      compression: 'none',
      headers: options.headers,
      maxSockets: options.maxSockets,
      logger: ctx.logger,
    });

    return {
      async run(sinkCtx) {
        try {
          await runBatchedSink<Uint8Array | undefined>(sinkCtx, {
            ...(options.batch?.maxEvents !== undefined
              ? { maxEvents: options.batch.maxEvents }
              : {}),
            ...(options.batch?.maxBytes !== undefined ? { maxBytes: options.batch.maxBytes } : {}),
            timeoutMs: options.batch?.timeout ?? 1_000,
            encode: (events: Event[]) => {
              const nowMs = sinkCtx.clock.now().toMillis();
              const series: RemoteWriteSeries[] = [];
              for (const event of events) {
                if (!(event instanceof MetricEvent)) {
                  event.metadata.finalizers.finish('rejected');
                  continue;
                }
                const value = accumulator.accumulate(event, nowMs);
                const timestampMs = event.timestamp?.toMillis() ?? nowMs;
                try {
                  series.push(...expandMetricToSeries(event, value, timestampMs));
                } catch (error) {
                  if (error instanceof UnsupportedMetricTypeError) {
                    event.metadata.finalizers.finish('rejected');
                    continue;
                  }
                  throw error;
                }
              }
              if (series.length === 0) return undefined;
              return snappyCompress(encodeWriteRequest(series));
            },
            send: async (body) => {
              if (body === undefined) return;
              const response = await client.request({
                method: 'POST',
                url: options.url,
                headers: {
                  'content-type': 'application/x-protobuf',
                  'content-encoding': 'snappy',
                  'x-prometheus-remote-write-version': '0.1.0',
                },
                body,
              });
              const error = ensureSuccess(response, 'E_PROM_REMOTE_WRITE_SINK');
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
