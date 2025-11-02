import type { Pipeline } from '@ferrule/runtime';
import { sendJson } from '../http-utils.js';
import type { RouteContext, RouteHandler } from '../router.js';

/** `GET /health`: the whole {@link PipelineHealth} snapshot. 200 only when the pipeline is fully
 * `running`; every other overall state (`starting`, `degraded`, `stopping`, `stopped`, `failed`)
 * is reported as 503, since none of them mean "ready to serve traffic". */
export function handleHealth(pipeline: Pipeline): RouteHandler {
  return (ctx: RouteContext): void => {
    const health = pipeline.health();
    sendJson(ctx.res, health.overall === 'running' ? 200 : 503, health);
  };
}

/** `GET /health/live`: a liveness probe. Only reports failure when the pipeline has reached the
 * unrecoverable `failed` state; every other state means the process itself is still fine. */
export function handleLive(pipeline: Pipeline): RouteHandler {
  return (ctx: RouteContext): void => {
    const alive = pipeline.health().overall !== 'failed';
    sendJson(ctx.res, alive ? 200 : 503, { status: alive ? 'ok' : 'failed' });
  };
}

/** `GET /health/ready`: a readiness probe. Only `running` counts as ready. */
export function handleReady(pipeline: Pipeline): RouteHandler {
  return (ctx: RouteContext): void => {
    const health = pipeline.health();
    const ready = health.overall === 'running';
    sendJson(ctx.res, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not_ready',
      overall: health.overall,
    });
  };
}
