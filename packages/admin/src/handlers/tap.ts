import type { ServerResponse } from 'node:http';
import { encodeJson, type Event } from '@ferrule/core';
import {
  DEFAULT_PORT,
  type Clock,
  type Logger,
  type Pipeline,
  type TapSubscription,
} from '@ferrule/runtime';
import { BadRequestError, NotFoundError } from '../errors.js';
import { eventToValue } from '../event-json.js';
import { applySecurityHeaders } from '../http-utils.js';
import type { RouteContext, RouteHandler } from '../router.js';
import type { AdminTapOptions } from '../types.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_QUEUE_CAPACITY = 1000;
const DEFAULT_MAX_LIMIT = 100_000;

type TapFormat = 'ndjson' | 'sse';

function parseLimit(raw: string | null, maxLimit: number): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError('limit must be a positive integer');
  return Math.min(n, maxLimit);
}

function parseSampleRate(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new BadRequestError('sample must be in (0, 1]');
  return n;
}

function parseFormat(raw: string | null): TapFormat {
  if (raw === null || raw === 'ndjson') return 'ndjson';
  if (raw === 'sse') return 'sse';
  throw new BadRequestError(`unknown format ${JSON.stringify(raw)} (expected ndjson or sse)`);
}

/** Writes `chunk` and, if the socket's write buffer is full, waits for it to drain (or for the
 * response to close) before returning. This is what turns a slow HTTP client into pipeline
 * backpressure *on this subscriber's own queue only*: while we're waiting here we aren't pulling
 * the next event from `subscription`, so its bounded queue fills up and starts dropping its
 * oldest entry (see `TapHub`) instead of either blocking the pipeline or growing Node's write
 * buffer without limit. */
function writeAwaitingDrain(res: ServerResponse, chunk: string): Promise<void> {
  const ok = res.write(chunk);
  if (ok) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onDrain = (): void => {
      res.off('close', onDone);
      resolve();
    };
    const onDone = (): void => {
      res.off('drain', onDrain);
      resolve();
    };
    res.once('drain', onDrain);
    res.once('close', onDone);
  });
}

function formatEvent(format: TapFormat, event: Event): string {
  const json = encodeJson(eventToValue(event));
  return format === 'sse' ? `data: ${json}\n\n` : `${json}\n`;
}

/** Writes an SSE heartbeat comment every `intervalMs`, via `clock.sleep` (not `setInterval`) so
 * the stream's timing goes through the same clock as everything else in the runtime and can be
 * driven deterministically in tests. Stops as soon as `signal` aborts. */
async function runHeartbeat(
  res: ServerResponse,
  clock: Clock,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    try {
      await clock.sleep(intervalMs, signal);
    } catch {
      return;
    }
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }
}

export interface TapDeps {
  readonly pipeline: Pipeline;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly options: AdminTapOptions;
  readonly onOpen: (subscription: TapSubscription) => void;
  readonly onClose: (subscription: TapSubscription) => void;
}

/**
 * `GET /tap/:component`: streams clones of events flowing through a component's output port as
 * they happen, as newline-delimited JSON (`?format=ndjson`, the default) or Server-Sent Events
 * (`?format=sse`, with periodic heartbeat comments so intermediaries don't time the connection
 * out). `?port=` selects a non-default output port, `?sample=` a sampling rate in (0, 1], and
 * `?limit=` a maximum number of events before the stream ends on its own. The stream also ends
 * when the client disconnects; either way the underlying `Pipeline.tap()` subscription is always
 * closed, so nothing leaks.
 */
export function handleTap(deps: TapDeps): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const componentId = ctx.params['component']!;
    const known = deps.pipeline.snapshot().components.some((c) => c.id === componentId);
    if (!known) throw new NotFoundError(`no component ${JSON.stringify(componentId)}`);

    const port = ctx.url.searchParams.get('port') ?? DEFAULT_PORT;
    const sampleRate = parseSampleRate(ctx.url.searchParams.get('sample'));
    const maxLimit = deps.options.maxLimit ?? DEFAULT_MAX_LIMIT;
    const limit = parseLimit(ctx.url.searchParams.get('limit'), maxLimit);
    const format = parseFormat(ctx.url.searchParams.get('format'));

    const subscription = deps.pipeline.tap(
      { componentId, port },
      {
        ...(sampleRate !== undefined ? { sampleRate } : {}),
        queueCapacity: deps.options.defaultQueueCapacity ?? DEFAULT_QUEUE_CAPACITY,
      },
    );
    deps.onOpen(subscription);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      subscription.close();
      deps.onClose(subscription);
    };
    ctx.req.on('close', close);
    ctx.res.on('close', close);

    applySecurityHeaders(ctx.res);
    ctx.res.setHeader('X-Accel-Buffering', 'no');
    if (format === 'sse') {
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
    } else {
      ctx.res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    }
    // Node buffers a writeHead() with no body until the first write() / end(), so without this a
    // client waiting on response headers to confirm the stream opened would hang until the first
    // event or heartbeat — which, with a quiet component and a long heartbeat interval, could be
    // a very long time.
    ctx.res.flushHeaders();

    const heartbeatAbort = new AbortController();
    const heartbeatMs = deps.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    const heartbeatLoop =
      format === 'sse'
        ? runHeartbeat(ctx.res, deps.clock, heartbeatMs, heartbeatAbort.signal)
        : Promise.resolve();

    try {
      let delivered = 0;
      for await (const event of subscription) {
        if (closed) break;
        await writeAwaitingDrain(ctx.res, formatEvent(format, event));
        delivered++;
        if (limit !== undefined && delivered >= limit) break;
      }
    } catch (error) {
      deps.logger.debug('tap stream ended with an error', {
        component: componentId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      heartbeatAbort.abort();
      await heartbeatLoop.catch(() => undefined);
      close();
      if (!ctx.res.writableEnded) ctx.res.end();
    }
  };
}
