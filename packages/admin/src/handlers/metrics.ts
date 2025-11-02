import type { MetricsRegistry } from '@ferrule/runtime';
import { encodePrometheusText } from '@ferrule/codecs';
import { sendJson, sendText } from '../http-utils.js';
import { metricEventToJson } from '../metrics-json.js';
import type { RouteContext, RouteHandler } from '../router.js';

function wantsJson(ctx: RouteContext): boolean {
  const format = ctx.url.searchParams.get('format');
  if (format === 'json') return true;
  if (format === 'text' || format === 'prometheus') return false;
  const accept = ctx.req.headers.accept;
  if (typeof accept !== 'string') return false;
  // A plain-text scraper (Prometheus itself, curl) sends `Accept: text/plain` or `*/*`; only a
  // client that specifically prefers JSON over plain text gets the JSON form.
  return accept.includes('application/json') && !accept.includes('text/plain');
}

/** `GET /metrics`: Ferrule's own internal metrics. Prometheus text exposition format by default
 * (what a Prometheus scrape config expects); `?format=json` or an `Accept: application/json`
 * request gets a JSON array instead. */
export function handleMetrics(metrics: MetricsRegistry): RouteHandler {
  return (ctx: RouteContext): void => {
    const events = metrics.snapshot();
    if (wantsJson(ctx)) {
      sendJson(ctx.res, 200, events.map(metricEventToJson));
      return;
    }
    sendText(
      ctx.res,
      200,
      encodePrometheusText(events),
      'text/plain; version=0.0.4; charset=utf-8',
    );
  };
}
