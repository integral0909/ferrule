/**
 * `http_server`: receives events as HTTP POST request bodies. Bodies are framed (one JSON
 * object per line, or the whole body as one document, depending on `decoding`) and decoded
 * through the `@ferrule/codecs` registry, so this source never re-implements a wire format —
 * it only owns the HTTP plumbing: routing, auth, TLS, decompression limits, backpressure, and
 * acknowledgement-aware responses.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import {
  BatchNotifier,
  isLogEvent,
  type DeliveryStatus,
  type Event,
  type EventKind,
} from '@ferrule/core';
import { decodeFrames, defaultCodecs, NewlineFramer, type CodecRegistry } from '@ferrule/codecs';
import {
  defineSource,
  DEFAULT_PORT,
  Metrics,
  type Source,
  type SourceContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { authSchema, decodingSchema, splitCodecOptions, tlsSchema } from './fragments.js';
import {
  checkAuth,
  errorBody,
  loadTlsServerOptions,
  parseContentEncoding,
  PayloadTooLargeError,
  readLimitedBody,
  remoteAddress,
  retryAfterSeconds,
  sendEmpty,
  sendJson,
} from './util/http.js';

const options = s.object({
  address: s
    .socketAddress(true)
    .default({ host: '0.0.0.0', port: 8080 })
    .describe('Address to listen on. Port 0 binds an OS-assigned ephemeral port.')
    .example('0.0.0.0:8080'),
  paths: s
    .array(s.string().nonEmpty(), { minItems: 1, unique: true })
    .default(['/'])
    .describe('Request paths that accept event POSTs.'),
  health_path: s
    .string()
    .default('/health')
    .describe('Path that answers liveness checks with 200.'),
  decoding: decodingSchema('ndjson'),
  framing: s
    .enum(['newline', 'whole'])
    .optional()
    .describe(
      'How a body is split into decoder frames: "newline" (one frame per line, the default for ' +
        'line-oriented codecs like ndjson/logfmt) or "whole" (the entire body is one frame, the ' +
        'default for document codecs like json/csv). Overrides the codec-based default.',
    ),
  max_line_length: s
    .byteSize()
    .default(1024 * 1024)
    .describe('Maximum length of one frame when framing is "newline".'),
  max_body_size: s
    .byteSize()
    .default(10 * 1024 * 1024)
    .describe('Maximum decompressed request body size. Larger bodies get 413.'),
  max_compressed_body_size: s
    .byteSize()
    .optional()
    .describe(
      'Maximum request body size on the wire, before decompression. Defaults to max_body_size.',
    ),
  max_concurrent_requests: s
    .integer({ min: 1 })
    .default(1024)
    .describe('Requests processed at once. Excess requests get 429 immediately.'),
  request_timeout: s
    .duration()
    .default(30_000)
    .describe('Time allowed to receive a full request before it is aborted.'),
  backpressure_timeout: s
    .duration()
    .default(5_000)
    .describe(
      'How long a request may wait for pipeline backpressure to clear before this source gives ' +
        'up on that response and replies 503 with Retry-After (the events already handed to the ' +
        'output are not withdrawn — they may still be delivered after the response is sent).',
    ),
  auth: authSchema,
  tls: tlsSchema,
  trust_forwarded_for: s
    .boolean()
    .default(false)
    .describe('Take the client address from X-Forwarded-For instead of the socket peer.'),
  metadata: s
    .object({
      remote_addr_field: s.string().default('http.remote_addr'),
      path_field: s.string().default('http.path'),
      query_field: s.string().default('http.query'),
      headers: s
        .array(s.string(), { unique: true })
        .default([])
        .describe('Header names copied to `http.headers.<lowercased name>`.'),
    })
    .default({
      remote_addr_field: 'http.remote_addr',
      path_field: 'http.path',
      query_field: 'http.query',
      headers: [],
    })
    .describe('Which request metadata is copied onto every decoded log event.'),
});

export type HttpServerOptions = Infer<typeof options>;

function producesForCodec(name: string): readonly EventKind[] {
  switch (name) {
    case 'prometheus_text':
    case 'statsd':
      return ['metric'];
    case 'otlp_protobuf':
    case 'otlp_json':
      return ['log', 'metric', 'span'];
    default:
      return ['log'];
  }
}

function defaultFraming(codecName: string): 'newline' | 'whole' {
  return codecName === 'json' || codecName === 'csv' || codecName === 'prometheus_text'
    ? 'whole'
    : 'newline';
}

/** Handle returned by {@link httpServerSource}'s `build`, beyond the fixed `Source` contract:
 * the address a running server actually bound to, for tests that listen on port 0. */
export interface HttpServerSourceHandle extends Source {
  address(): { host: string; port: number } | undefined;
}

interface RequestOutcome {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function frameBody(
  body: Buffer,
  framing: 'newline' | 'whole',
  maxLineLength: number,
): Uint8Array[] {
  if (framing === 'whole') {
    return body.length === 0 ? [] : [new Uint8Array(body.buffer, body.byteOffset, body.byteLength)];
  }
  const framer = new NewlineFramer({ maxLineLength, onOversize: 'error' });
  const frames = framer.push(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  frames.push(...framer.finish());
  return frames.filter((f) => f.length > 0);
}

function applyMetadata(
  events: readonly Event[],
  fields: {
    remoteAddr: string | undefined;
    path: string;
    query: string;
    headers: readonly [string, string][];
  },
  metadata: HttpServerOptions['metadata'],
): void {
  for (const event of events) {
    if (!isLogEvent(event)) continue;
    if (fields.remoteAddr !== undefined) event.set(metadata.remote_addr_field, fields.remoteAddr);
    event.set(metadata.path_field, fields.path);
    if (fields.query !== '') event.set(metadata.query_field, fields.query);
    for (const [name, value] of fields.headers) event.set(`http.headers.${name}`, value);
  }
}

function statusForDeliveryStatus(status: DeliveryStatus): number {
  switch (status) {
    case 'delivered':
      return 200;
    case 'errored':
      return 503;
    case 'rejected':
      return 400;
  }
}

export const httpServerSource = defineSource<HttpServerOptions>({
  kind: 'source',
  type: 'http_server',
  description: 'Receives log, metric, or span events as HTTP POST request bodies.',
  options,
  produces: (opts) => producesForCodec(opts.decoding.codec),
  examples: [
    {
      title: 'Receive NDJSON logs with a bearer token',
      config: {
        address: '0.0.0.0:8080',
        decoding: { codec: 'ndjson' },
        auth: { strategy: 'bearer', token: '${secret:TOKEN}' },
      },
    },
  ],
  build(opts, _buildCtx): HttpServerSourceHandle {
    const codecs: CodecRegistry = defaultCodecs;
    const [decodingCodec, decodingOptions] = splitCodecOptions(opts.decoding);
    const decoder = codecs.createDecoder(decodingCodec, decodingOptions);
    const framing = opts.framing ?? defaultFraming(decodingCodec);
    const acceptedPaths = new Set(opts.paths);
    const maxCompressed = opts.max_compressed_body_size ?? opts.max_body_size;

    let boundAddress: { host: string; port: number } | undefined;

    async function run(ctx: SourceContext): Promise<void> {
      if (ctx.signal.aborted) return;
      const requestsErrored = ctx.metrics.counter(Metrics.errors);
      const requestsReceived = ctx.metrics.counter('http_server_requests_total');
      const requestsRejected = ctx.metrics.counter('http_server_requests_rejected_total');
      const requestDuration = ctx.metrics.histogram(Metrics.requestDurationSeconds);
      let activeRequests = 0;
      let shuttingDown = false;

      const server: Server =
        opts.tls === undefined
          ? createHttpServer()
          : createHttpsServer(await loadTlsServerOptions(opts.tls));
      server.requestTimeout = opts.request_timeout;
      server.headersTimeout = Math.min(server.headersTimeout, Math.max(1, opts.request_timeout));

      const sockets = new Set<Socket>();
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });

      async function respondAuthAndFraming(
        req: IncomingMessage,
        _res: ServerResponse,
      ): Promise<RequestOutcome> {
        const auth = checkAuth(req.headers.authorization, opts.auth);
        if (!auth.ok) {
          const headers = auth.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined;
          return {
            status: auth.status,
            body: errorBody('E_UNAUTHORIZED', auth.message),
            ...(headers !== undefined ? { headers } : {}),
          };
        }
        const encoding = parseContentEncoding(req.headers['content-encoding']);
        if (encoding === undefined) {
          return {
            status: 415,
            body: errorBody('E_UNSUPPORTED_ENCODING', 'unsupported Content-Encoding'),
          };
        }
        let body: Buffer;
        try {
          // Deliberately not tied to `ctx.signal`: once a request's headers have been accepted
          // it is "in-flight work" per the component contract, and a graceful shutdown (which
          // aborts `ctx.signal` while the server keeps serving connections that are already
          // open) must let it finish rather than cutting its body read short.
          body = await readLimitedBody(req, {
            encoding,
            maxBytes: opts.max_body_size,
            maxCompressedBytes: maxCompressed,
          });
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            return { status: 413, body: errorBody(error.code, error.message) };
          }
          throw error;
        }
        let frames: Uint8Array[];
        try {
          frames = frameBody(body, framing, opts.max_line_length);
        } catch (error) {
          return {
            status: 400,
            body: errorBody('E_FRAME', error instanceof Error ? error.message : String(error)),
          };
        }
        if (frames.length === 0) return { status: 204 };

        const { events, errors } = decodeFrames(decoder, frames);
        if (errors.length > 0) {
          const first = errors[0]!;
          return {
            status: 400,
            body: errorBody(first.error.code, `frame ${first.frameIndex}: ${first.error.message}`),
          };
        }
        if (events.length === 0) return { status: 204 };

        const url = new URL(req.url ?? '/', 'http://placeholder');
        const headerFields: [string, string][] = [];
        for (const name of opts.metadata.headers ?? []) {
          const value = req.headers[name.toLowerCase()];
          if (value !== undefined) {
            headerFields.push([
              name.toLowerCase(),
              Array.isArray(value) ? value.join(', ') : value,
            ]);
          }
        }
        applyMetadata(
          events,
          {
            remoteAddr: remoteAddress(req, opts.trust_forwarded_for),
            path: url.pathname,
            query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
            headers: headerFields,
          },
          opts.metadata,
        );

        const batch = new BatchNotifier();
        for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
        batch.seal();

        const sendPromise = ctx.output.send(events, DEFAULT_PORT);
        // The timeout race is deliberately *not* tied to `ctx.signal`: on a graceful shutdown
        // the channel this send() targets stays open (and this request is in-flight work that
        // should finish) until this source's run() actually returns, so an abort here must not
        // be treated as "the pipeline gave up". Only a genuine timer, or `sendPromise` itself
        // settling, ends the race.
        let raceResult: 'sent' | 'timed_out';
        try {
          raceResult = await Promise.race([
            sendPromise.then((): 'sent' => 'sent'),
            ctx.clock.sleep(opts.backpressure_timeout).then((): 'timed_out' => 'timed_out'),
          ]);
        } catch (error) {
          // `sendPromise` rejected outright (e.g. the pipeline force-finalized this batch during
          // a shutdown deadline) before the timeout could even matter.
          ctx.logger.warn('http_server: send failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            status: 503,
            body: errorBody('E_DELIVERY_ERRORED', 'delivery failed; retry'),
            headers: { 'retry-after': '1' },
          };
        }
        if (raceResult === 'timed_out') {
          sendPromise.catch(() => {
            // Already reported to the client as unaccepted; nothing more to do here if the
            // pipeline later fails to admit the batch (its finalizers still resolve normally
            // when it does succeed, independent of this response).
          });
          return {
            status: 503,
            body: errorBody('E_BACKPRESSURE', 'the pipeline is applying backpressure; retry later'),
            headers: { 'retry-after': String(retryAfterSeconds(opts.backpressure_timeout)) },
          };
        }

        if (!ctx.acknowledgements) return { status: 200, body: { accepted: events.length } };

        const status = await batch.completion;
        const code = statusForDeliveryStatus(status);
        if (code === 200) return { status: 200, body: { accepted: events.length } };
        if (code === 503) {
          return {
            status: 503,
            body: errorBody('E_DELIVERY_ERRORED', 'delivery failed transiently; retry'),
            headers: { 'retry-after': String(retryAfterSeconds(1000)) },
          };
        }
        return {
          status: 400,
          body: errorBody('E_DELIVERY_REJECTED', 'delivery was permanently rejected'),
        };
      }

      async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const startedAt = ctx.clock.monotonic();
        activeRequests++;
        requestsReceived.increment();
        try {
          const url = new URL(req.url ?? '/', 'http://placeholder');
          if (req.method === 'GET' && url.pathname === opts.health_path) {
            sendJson(res, shuttingDown ? 503 : 200, {
              status: shuttingDown ? 'shutting_down' : 'ok',
            });
            return;
          }
          if (req.method !== 'POST' || !acceptedPaths.has(url.pathname)) {
            sendJson(res, 404, errorBody('E_NOT_FOUND', 'no such route'));
            return;
          }
          if (activeRequests > opts.max_concurrent_requests) {
            requestsRejected.increment();
            sendJson(res, 429, errorBody('E_TOO_MANY_REQUESTS', 'too many concurrent requests'), {
              'retry-after': '1',
            });
            return;
          }
          const outcome = await respondAuthAndFraming(req, res);
          if (outcome.status === 204) {
            sendEmpty(res, 204);
          } else {
            sendJson(res, outcome.status, outcome.body ?? {}, outcome.headers);
          }
        } catch (error) {
          requestsErrored.increment();
          ctx.logger.error('http_server: request failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) sendJson(res, 500, errorBody('E_INTERNAL', 'internal error'));
        } finally {
          activeRequests--;
          requestDuration.record((ctx.clock.monotonic() - startedAt) / 1000);
          if (shuttingDown) server.closeIdleConnections();
        }
      }

      server.on('request', (req, res) => {
        handleRequest(req, res).catch((error: unknown) => {
          ctx.logger.error('http_server: unhandled request error', { error: String(error) });
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.address.port, opts.address.host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const listening = server.address();
      boundAddress =
        listening !== null && typeof listening === 'object'
          ? { host: listening.address, port: listening.port }
          : opts.address;
      ctx.logger.info('http_server: listening', { address: boundAddress });

      const stopped = new Promise<void>((resolve) => server.once('close', resolve));
      const onAbort = (): void => {
        shuttingDown = true;
        server.close();
        server.closeIdleConnections();
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await stopped;
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
        boundAddress = undefined;
      }
    }

    return { run, address: () => boundAddress };
  },
});

export default httpServerSource;
