import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createNullLogger,
  SystemClock,
  type Clock,
  type Logger,
  type TapSubscription,
} from '@ferrule/runtime';
import { checkHost, requireAuth } from './auth.js';
import { RequestTimeoutError } from './errors.js';
import { handleComponent } from './handlers/components.js';
import { handleConfig } from './handlers/config.js';
import { handleHealth, handleLive, handleReady } from './handlers/health.js';
import { handleMetrics } from './handlers/metrics.js';
import { handleReload } from './handlers/reload.js';
import { handleTap } from './handlers/tap.js';
import { handleTopology } from './handlers/topology.js';
import { describeThrown, readBody, sendError } from './http-utils.js';
import { Router, type RouteContext } from './router.js';
import type { AdminServer, AdminServerOptions, BoundAddress } from './types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

class AdminServerImpl implements AdminServer {
  private readonly server: Server;
  private readonly router = new Router();
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly openTaps = new Set<TapSubscription>();
  private bound: BoundAddress | undefined;

  constructor(private readonly options: AdminServerOptions) {
    this.logger = options.logger ?? createNullLogger();
    this.clock = options.clock ?? new SystemClock();
    this.registerRoutes();
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error: unknown) => {
        this.logger.error('unhandled admin request error', {
          error: error instanceof Error ? error.message : String(error),
        });
        sendError(res, 500, 'E_INTERNAL', 'internal server error');
      });
    });
  }

  get address(): BoundAddress | undefined {
    return this.bound;
  }

  activeTapCount(): number {
    return this.openTaps.size;
  }

  private registerRoutes(): void {
    const { pipeline, metrics } = this.options;
    this.router.get('/health', handleHealth(pipeline));
    this.router.get('/health/live', handleLive(pipeline));
    this.router.get('/health/ready', handleReady(pipeline));
    this.router.get('/topology', handleTopology(pipeline));
    this.router.get('/metrics', handleMetrics(metrics));
    this.router.get('/components/:id', handleComponent(pipeline, metrics));
    this.router.get(
      '/tap/:component',
      handleTap({
        pipeline,
        clock: this.clock,
        logger: this.logger,
        options: this.options.tap ?? {},
        onOpen: (sub) => this.openTaps.add(sub),
        onClose: (sub) => this.openTaps.delete(sub),
      }),
    );
    this.router.get('/config', handleConfig(this.options.configDump));
    this.router.post('/reload', handleReload(this.options.onReload));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const bound = this.bound;
      if (bound !== undefined) checkHost(req, bound, this.options.allowedHosts ?? []);

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const { handler, params } = this.router.resolve(req, url);

      const auth = this.options.auth;
      if (auth !== undefined && (req.method !== 'GET' || auth.requireForAll === true)) {
        requireAuth(req, auth);
      }

      const ctx: RouteContext = { req, res, url, params };
      const run = async (): Promise<void> => {
        if (req.method === 'POST') {
          await readBody(req, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        }
        await handler(ctx);
      };

      if (url.pathname.startsWith('/tap/')) {
        // /tap is a long-lived stream by design; the request timeout only applies to endpoints
        // that are supposed to answer promptly.
        await run();
        return;
      }
      await this.withTimeout(run(), this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    } catch (error) {
      this.respondError(res, error);
    }
  }

  private async withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new RequestTimeoutError());
      }, timeoutMs);
    });
    try {
      await Promise.race([promise, timeout]);
    } catch (error) {
      // If the handler eventually settles after we've already responded (or moved on), swallow
      // whatever it does: a second write attempt is guarded by `res.writableEnded` in the send
      // helpers, but an otherwise-unhandled rejection from the abandoned promise must not escape.
      if (timedOut) promise.catch(() => undefined);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private respondError(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const described = describeThrown(error, this.logger);
    sendError(res, described.status, described.code, described.message, described.headers);
  }

  async start(): Promise<BoundAddress> {
    const host = this.options.address?.host ?? DEFAULT_HOST;
    const port = this.options.address?.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = this.server.address() as AddressInfo;
    this.bound = { host, port: addr.port };
    return this.bound;
  }

  async stop(): Promise<void> {
    for (const sub of [...this.openTaps]) sub.close();
    this.openTaps.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.bound = undefined;
  }
}

/** Builds an embeddable admin HTTP server: health, topology, metrics, component detail, a live
 * event tap, config dump, and hot reload, over `node:http`. Binds to `127.0.0.1` by default. See
 * the package README for the full endpoint reference. */
export function createAdminServer(options: AdminServerOptions): AdminServer {
  return new AdminServerImpl(options);
}
