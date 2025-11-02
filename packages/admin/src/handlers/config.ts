import { NotConfiguredError } from '../errors.js';
import { sendText } from '../http-utils.js';
import type { RouteContext, RouteHandler } from '../router.js';

/** `GET /config`: the redacted effective configuration text, from the `configDump` callback the
 * embedder (the CLI) supplied. Never the raw configuration — redaction is `configDump`'s job, not
 * this endpoint's. 404 if the server wasn't given one. */
export function handleConfig(
  configDump: (() => string | Promise<string>) | undefined,
): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    if (configDump === undefined) {
      throw new NotConfiguredError('this admin server has no configDump source configured');
    }
    const text = await configDump();
    sendText(ctx.res, 200, text);
  };
}
