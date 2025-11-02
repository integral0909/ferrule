import type { MetricsRegistry, Pipeline } from '@ferrule/runtime';
import { NotFoundError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import { metricEventToJson } from '../metrics-json.js';
import type { RouteContext, RouteHandler } from '../router.js';
import type { ComponentDetail } from '../types.js';

/** `GET /components/:id`: one component's health plus the metrics recorded under its identity
 * (every instrument the runtime tags with `component_id: id`). 404 if no such component exists in
 * the current topology. */
export function handleComponent(pipeline: Pipeline, metrics: MetricsRegistry): RouteHandler {
  return (ctx: RouteContext): void => {
    const id = ctx.params['id']!;
    const health = pipeline.health().components.find((c) => c.id === id);
    if (health === undefined) throw new NotFoundError(`no component ${JSON.stringify(id)}`);
    const componentMetrics = metrics
      .snapshot()
      .filter((event) => event.series.tags.get('component_id') === id)
      .map(metricEventToJson);
    const detail: ComponentDetail = {
      id: health.id,
      kind: health.kind,
      type: health.type,
      state: health.state,
      ...(health.error !== undefined ? { error: health.error } : {}),
      metrics: componentMetrics,
    };
    sendJson(ctx.res, 200, detail);
  };
}
