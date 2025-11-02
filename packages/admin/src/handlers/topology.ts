import type { Pipeline } from '@ferrule/runtime';
import { BadRequestError } from '../errors.js';
import { sendJson, sendText } from '../http-utils.js';
import type { RouteContext, RouteHandler } from '../router.js';
import { renderDot, renderMermaid } from '../topology-render.js';

/** `GET /topology`: the running graph — components, kinds, types, inputs — as JSON by default, or
 * as a Graphviz `dot` (`?format=dot`) or Mermaid (`?format=mermaid`) rendering colored by each
 * component's current state. */
export function handleTopology(pipeline: Pipeline): RouteHandler {
  return (ctx: RouteContext): void => {
    const format = ctx.url.searchParams.get('format') ?? 'json';
    const snapshot = pipeline.snapshot();
    switch (format) {
      case 'json':
        sendJson(ctx.res, 200, snapshot);
        return;
      case 'dot':
        sendText(
          ctx.res,
          200,
          renderDot(snapshot, pipeline.health().components),
          'text/vnd.graphviz; charset=utf-8',
        );
        return;
      case 'mermaid':
        sendText(ctx.res, 200, renderMermaid(snapshot, pipeline.health().components));
        return;
      default:
        throw new BadRequestError(
          `unknown format ${JSON.stringify(format)} (expected json, dot, or mermaid)`,
        );
    }
  };
}
