import type { ReloadResult } from '@ferrule/runtime';
import { NotConfiguredError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import type { RouteContext, RouteHandler } from '../router.js';

/** `POST /reload`: triggers a hot reload through the `onReload` callback the embedder (the CLI)
 * supplied and returns its structured {@link ReloadResult} — `added`/`removed`/`changed`/
 * `unchanged` component IDs on success (200), or validation diagnostics on failure (422, since the
 * request was well-formed but the resulting configuration wasn't). 404 if the server wasn't given
 * a reload handler. This is the one mutating endpoint in the admin API. */
export function handleReload(
  onReload: (() => ReloadResult | Promise<ReloadResult>) | undefined,
): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    if (onReload === undefined) {
      throw new NotConfiguredError('this admin server has no onReload handler configured');
    }
    const result = await onReload();
    sendJson(ctx.res, result.ok ? 200 : 422, result);
  };
}
