/**
 * `prometheus_scrape`: polls a set of `/metrics` endpoints on an interval and decodes their
 * responses with `@ferrule/codecs`'s Prometheus text exposition format decoder. This source owns
 * only the scrape loop (interval timing, per-target HTTP requests, bounded concurrency,
 * `instance`/`job` labelling) — parsing the wire format is entirely the codec's job.
 *
 * Unlike the HTTP receivers in this package, nothing here is waiting on a response to a client:
 * a scrape failure has nowhere to retry against except the next scheduled round, so failures are
 * caught, logged, and counted per target rather than propagated. A `BatchNotifier` is still
 * created per successful scrape (one target's one round is the unit of work) so that, with
 * acknowledgements enabled, backpressure from a slow pipeline is observed before starting the
 * next target/round — the same reasoning `statsd` and `syslog` apply to their own unacknowledged
 * wire protocols.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  BatchNotifier,
  FerruleError,
  isMetricEvent,
  type Event,
  type MetricEvent,
} from '@ferrule/core';
import { defaultCodecs, type Decoder } from '@ferrule/codecs';
import { defineSource, Metrics, type Source, type SourceContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

const targetSchema = s.object({
  url: s.url({ protocols: ['http', 'https'] }).describe('The /metrics endpoint to scrape.'),
  job: s
    .string()
    .optional()
    .describe(
      'The "job" label set on every metric scraped from this target. Default "prometheus_scrape".',
    ),
  instance: s
    .string()
    .optional()
    .describe(
      'The "instance" label set on every metric scraped from this target. Defaults to the URL\'s host:port.',
    ),
  labels: s
    .record(s.string())
    .optional()
    .describe('Additional static labels set on every metric scraped from this target.'),
});

const options = s.object({
  targets: s
    .array(targetSchema, { minItems: 1 })
    .describe('Endpoints polled for Prometheus text exposition metrics.'),
  interval: s
    .duration()
    .default(15_000)
    .describe('Time between the start of one scrape round and the next.'),
  scrape_timeout: s
    .duration()
    .default(10_000)
    .describe('Per-target request timeout. A target that does not respond in time is aborted.'),
  concurrency: s
    .integer({ min: 1 })
    .default(8)
    .describe('Maximum number of targets scraped in parallel within one round.'),
  honor_labels: s
    .boolean()
    .default(false)
    .describe(
      'When false (the default), the instance/job/target-label values from configuration always ' +
        'overwrite any same-named label already present on a scraped metric. When true, a label ' +
        'already present on the scraped metric is left alone and only missing labels are filled in.',
    ),
  decoding: s
    .unknown()
    .optional()
    .describe('Options passed through to the Prometheus text decoder.'),
});

export type PrometheusScrapeOptions = Infer<typeof options>;
export type PrometheusScrapeTargetOptions = Infer<typeof targetSchema>;

interface ResolvedTarget {
  readonly rawUrl: string;
  readonly url: URL;
  readonly job: string;
  readonly instance: string;
  readonly labels: Map<string, string> | undefined;
}

function resolveTarget(target: PrometheusScrapeTargetOptions): ResolvedTarget {
  const url = new URL(target.url);
  return {
    rawUrl: target.url,
    url,
    job: target.job ?? 'prometheus_scrape',
    instance: target.instance ?? url.host,
    labels: target.labels,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Issues one GET request for `url`, real-timer-bounded by `timeoutMs` (this bounds actual I/O,
 * so it deliberately does not use `ctx.clock`, which tests drive virtually). Resolves with the
 * decoded response body text, or rejects on a connection failure, a non-2xx status, or a timeout. */
function scrapeHttp(url: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`scrape timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = client(url, { method: 'GET', signal: controller.signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`unexpected HTTP status ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', (error) => reject(error));
    });
    req.on('error', (error) => reject(error));
    req.once('close', () => clearTimeout(timer));
    req.end();
  });
}

function applyTargetLabels(
  events: readonly MetricEvent[],
  target: ResolvedTarget,
  honorLabels: boolean,
): void {
  for (const event of events) {
    if (target.labels !== undefined) {
      for (const [key, value] of target.labels) {
        if (!honorLabels || !event.tags.has(key)) event.tags.set(key, value);
      }
    }
    if (!honorLabels || !event.tags.has('instance')) event.tags.set('instance', target.instance);
    if (!honorLabels || !event.tags.has('job')) event.tags.set('job', target.job);
  }
}

async function scrapeOne(
  target: ResolvedTarget,
  opts: PrometheusScrapeOptions,
  decoder: Decoder,
  ctx: SourceContext,
): Promise<void> {
  const startedAt = ctx.clock.monotonic();
  const failures = ctx.metrics.counter('prometheus_scrape_failures_total', {
    target: target.rawUrl,
  });

  let body: string;
  try {
    body = await scrapeHttp(target.url, opts.scrape_timeout);
  } catch (error) {
    failures.increment();
    ctx.logger.warn('prometheus_scrape: scrape failed', {
      target: target.rawUrl,
      error: errorMessage(error),
    });
    return;
  }

  let events: Event[];
  try {
    events = decoder.decode(Buffer.from(body, 'utf8'));
  } catch (error) {
    if (!(error instanceof FerruleError)) throw error;
    failures.increment();
    ctx.logger.warn('prometheus_scrape: failed to decode scrape response', {
      target: target.rawUrl,
      error: error.message,
    });
    return;
  }

  const metricEvents = events.filter(isMetricEvent);
  applyTargetLabels(metricEvents, target, opts.honor_labels);

  if (metricEvents.length > 0) {
    const batch = new BatchNotifier();
    for (const event of metricEvents) event.metadata.finalizers.add(batch.createFinalizer());
    batch.seal();
    await ctx.output.send(metricEvents);
    if (ctx.acknowledgements) await batch.completion;
  }

  ctx.metrics
    .histogram(Metrics.requestDurationSeconds, { target: target.rawUrl })
    .record((ctx.clock.monotonic() - startedAt) / 1000);
  ctx.metrics.counter('prometheus_scrape_success_total', { target: target.rawUrl }).increment();
}

/** Runs `worker` over `items` with at most `limit` concurrent calls in flight — a small bounded
 * concurrency pool of workers, each pulling the next item off a shared index once it finishes its
 * current one, rather than spawning `items.length` promises up front. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function poolWorker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => poolWorker()));
}

async function runRound(
  ctx: SourceContext,
  targets: readonly ResolvedTarget[],
  opts: PrometheusScrapeOptions,
  decoder: Decoder,
): Promise<void> {
  await runWithConcurrency(targets, opts.concurrency, (target) =>
    scrapeOne(target, opts, decoder, ctx),
  );
}

export const prometheusScrapeSource = defineSource<PrometheusScrapeOptions>({
  kind: 'source',
  type: 'prometheus_scrape',
  description: 'Polls Prometheus-format /metrics endpoints on an interval.',
  options,
  produces: () => ['metric'],
  examples: [
    {
      title: 'Scrape one local exporter every 15 seconds',
      config: { targets: [{ url: 'http://127.0.0.1:9100/metrics' }] },
    },
  ],
  build(opts, _buildCtx): Source {
    const decoder = defaultCodecs.createDecoder('prometheus_text', opts.decoding);
    const resolvedTargets = opts.targets.map(resolveTarget);

    async function run(ctx: SourceContext): Promise<void> {
      if (ctx.signal.aborted) return;
      for (;;) {
        if (ctx.signal.aborted) break;
        await runRound(ctx, resolvedTargets, opts, decoder);
        if (ctx.signal.aborted) break;
        try {
          await ctx.clock.sleep(opts.interval, ctx.signal);
        } catch {
          break;
        }
      }
    }

    return { run };
  },
});

export default prometheusScrapeSource;
