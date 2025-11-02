import type { IncomingMessage, ServerResponse } from 'node:http';
import { MethodNotAllowedError, NotFoundError } from './errors.js';

export type HttpMethod = 'GET' | 'POST';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(a);
    else if (p !== a) return undefined;
  }
  return params;
}

/**
 * A minimal method + path router with `:param` segments. The admin API's route set is small and
 * fixed, so this deliberately doesn't support wildcards, regexes, or middleware chains.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: splitPath(pattern), handler });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): void {
    this.add('POST', pattern, handler);
  }

  /**
   * Resolves `req`'s method and `url`'s path to a handler and its path parameters. Throws
   * {@link NotFoundError} if no route's path matches, or {@link MethodNotAllowedError} (carrying
   * every method that does match the path) if one does but not for this method.
   */
  resolve(
    req: IncomingMessage,
    url: URL,
  ): { handler: RouteHandler; params: Record<string, string> } {
    const segments = splitPath(url.pathname);
    let pathMatched = false;
    const allowedMethods = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (params === undefined) continue;
      pathMatched = true;
      allowedMethods.add(route.method);
      if (route.method === req.method) return { handler: route.handler, params };
    }
    if (pathMatched) throw new MethodNotAllowedError([...allowedMethods]);
    throw new NotFoundError(`no route for ${req.method ?? '?'} ${url.pathname}`);
  }
}
