import * as http from 'node:http';
import { encodePrometheusText } from '@ferrule/codecs';
import {
  addMetricValues,
  cloneMetricValue,
  cloneSeries,
  MetricEvent,
  seriesKey,
  type MetricSeries,
  type MetricValue,
} from '@ferrule/core';
import { defineSink } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

export const prometheusExporterSinkOptions = s.object({
  /** Listen address. Port `0` binds an OS-assigned ephemeral port (useful in tests). */
  listen_address: s.socketAddress(true),
  path: s.string().default('/metrics'),
  /** A series not observed for longer than this is dropped from the next scrape. */
  stale_bound: s.duration({ minMs: 1 }).default(5 * 60_000),
  include_timestamps: s.boolean().default(false),
});
export type PrometheusExporterSinkOptions = Infer<typeof prometheusExporterSinkOptions>;

interface SeriesState {
  series: MetricSeries;
  value: MetricValue;
  lastWallMs: number;
}

/** Keeps the latest (or, for `incremental` metrics, the running accumulated) value per series,
 * for {@link prometheusExporterSink} to serve on scrape. */
class SeriesStore {
  private readonly state = new Map<string, SeriesState>();

  observe(event: MetricEvent, nowMs: number): void {
    const key = seriesKey(event.series);
    if (
      event.metricKind === 'absolute' ||
      event.value.type === 'summary' ||
      event.value.type === 'set'
    ) {
      this.state.set(key, {
        series: cloneSeries(event.series),
        value: cloneMetricValue(event.value),
        lastWallMs: nowMs,
      });
      return;
    }
    const prior = this.state.get(key);
    const combined = prior === undefined ? undefined : addMetricValues(prior.value, event.value);
    const value = combined ?? event.value;
    this.state.set(key, {
      series: cloneSeries(event.series),
      value: cloneMetricValue(value),
      lastWallMs: nowMs,
    });
  }

  /** Removes series not observed within `staleBoundMs` of `nowMs` and returns the current
   * snapshot as absolute `MetricEvent`s, suitable for `encodePrometheusText`. */
  snapshot(nowMs: number, staleBoundMs: number): MetricEvent[] {
    const events: MetricEvent[] = [];
    for (const [key, entry] of this.state) {
      if (nowMs - entry.lastWallMs > staleBoundMs) {
        this.state.delete(key);
        continue;
      }
      events.push(
        new MetricEvent({
          name: entry.series.name,
          ...(entry.series.namespace !== undefined ? { namespace: entry.series.namespace } : {}),
          tags: entry.series.tags,
          kind: 'absolute',
          value: entry.value,
        }),
      );
    }
    return events;
  }

  get size(): number {
    return this.state.size;
  }
}

/** A pull-based sink: serves the accumulated series as Prometheus text exposition format on
 * `GET <path>`. Events are `delivered` as soon as they are incorporated into the served state —
 * this sink has no notion of a downstream acknowledgement, since delivery is "a scraper will read
 * this eventually," not a request this sink itself makes. */
export const prometheusExporterSink = defineSink<PrometheusExporterSinkOptions>({
  kind: 'sink',
  type: 'prometheus_exporter',
  description: 'Serves the latest metric values as a Prometheus scrape endpoint.',
  options: prometheusExporterSinkOptions,
  accepts: ['metric'],
  examples: [{ title: 'Serve /metrics on port 9102', config: { listen_address: '0.0.0.0:9102' } }],
  build: (options, ctx) => {
    const store = new SeriesStore();
    const scrapePath = options.path;

    return {
      async run(sinkCtx) {
        const server = http.createServer((req, res) => {
          let pathname: string;
          try {
            pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          } catch {
            pathname = req.url ?? '/';
          }
          if (req.method !== 'GET' || pathname !== scrapePath) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
          }
          const nowMs = sinkCtx.clock.now().toMillis();
          const text = encodePrometheusText(store.snapshot(nowMs, options.stale_bound), {
            includeTimestamps: options.include_timestamps,
          });
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(text);
        });

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.listen_address.port, options.listen_address.host, () => resolve());
        });
        const bound = server.address();
        const boundPort =
          typeof bound === 'object' && bound !== null ? bound.port : options.listen_address.port;
        ctx.logger.info('prometheus_exporter: listening', {
          host: options.listen_address.host,
          port: boundPort,
          path: scrapePath,
        });

        try {
          for await (const batch of sinkCtx.input) {
            const nowMs = sinkCtx.clock.now().toMillis();
            for (const event of batch) {
              if (event instanceof MetricEvent) store.observe(event, nowMs);
              event.metadata.finalizers.finish('delivered');
            }
          }
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    };
  },
});
