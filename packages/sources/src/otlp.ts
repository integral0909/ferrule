/**
 * `otlp`: an OTLP/HTTP receiver for logs, metrics, and traces (the standard OpenTelemetry
 * Protocol over HTTP — https://opentelemetry.io/docs/specs/otlp/#otlphttp). Shares its HTTP
 * plumbing (bounded/decompressing body reads, auth, TLS, response helpers) with `http_server`
 * via `./util/http.js`; what is specific to this source is OTLP's fixed routing
 * (`<base_path>/logs|metrics|traces`), its two wire formats (protobuf and OTLP/JSON), and its
 * response conventions (an `Export<Signal>ServiceResponse` body on success, a
 * `google.rpc.Status`-shaped body on failure). Decoding is always delegated to
 * `@ferrule/codecs`'s OTLP decoders — this file never parses OTLP bytes itself.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { BatchNotifier, FerruleError, type DeliveryStatus, type Event } from '@ferrule/core';
import {
  decodeExportLogsServiceRequest,
  decodeExportMetricsServiceRequest,
  decodeExportTraceServiceRequest,
  decodeOtlpJsonLogs,
  decodeOtlpJsonMetrics,
  decodeOtlpJsonTraces,
  ProtoWriter,
  type OtlpSignal,
} from '@ferrule/codecs';
import {
  defineSource,
  DEFAULT_PORT,
  Metrics,
  type Source,
  type SourceContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { authSchema, tlsSchema } from './fragments.js';
import {
  checkAuth,
  loadTlsServerOptions,
  parseContentEncoding,
  PayloadTooLargeError,
  readLimitedBody,
  retryAfterSeconds,
} from './util/http.js';

const options = s.object({
  address: s
    .socketAddress(true)
    .default({ host: '0.0.0.0', port: 4318 })
    .describe(
      'Address to listen on. Port 0 binds an OS-assigned ephemeral port. 4318 is the ' +
        'conventional OTLP/HTTP port.',
    )
    .example('0.0.0.0:4318'),
  base_path: s
    .string()
    .nonEmpty()
    .default('/v1')
    .describe(
      'Base path OTLP endpoints are mounted under: POSTs to "<base_path>/logs", ' +
        '"<base_path>/metrics", and "<base_path>/traces" are accepted.',
    ),
  health_path: s
    .string()
    .default('/health')
    .describe('Path that answers liveness checks with 200.'),
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
});

export type OtlpOptions = Infer<typeof options>;

/** Handle returned by {@link otlpSource}'s `build`, beyond the fixed `Source` contract: the
 * address a running server actually bound to, for tests that listen on port 0. */
export interface OtlpSourceHandle extends Source {
  address(): { host: string; port: number } | undefined;
}

// -------------------------------------------------------------------------------------------
// Wire formats and response bodies
// -------------------------------------------------------------------------------------------

type WireFormat = 'protobuf' | 'json';

const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';
const JSON_CONTENT_TYPE = 'application/json';

/** Parses a `Content-Type` header (ignoring any `;` parameters such as `charset`) into the two
 * wire formats OTLP/HTTP defines. `undefined` means the media type is not one this source
 * accepts (the caller answers 415). */
function parseRequestFormat(header: string | string[] | undefined): WireFormat | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  if (mediaType === PROTOBUF_CONTENT_TYPE) return 'protobuf';
  if (mediaType === JSON_CONTENT_TYPE) return 'json';
  return undefined;
}

/** `google.rpc.Code` values used by this source's error responses — just the handful relevant to
 * an HTTP receiver, not the full enum. */
const RpcCode = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** The per-signal field name OTLP/JSON uses for a partial-success rejection count, and the
 * (identical, per the `opentelemetry-proto` message definitions) field number 1 the protobuf
 * response uses for it — `error_message` is always field 2 / `errorMessage`. */
function rejectedCountJsonField(signal: OtlpSignal): string {
  switch (signal) {
    case 'logs':
      return 'rejectedLogRecords';
    case 'metrics':
      return 'rejectedDataPoints';
    case 'traces':
      return 'rejectedSpans';
  }
}

/**
 * Encodes an `Export<Signal>ServiceResponse` message: an empty message (0 bytes) when there is
 * nothing to report, or one holding a `partial_success` (field 1) — itself
 * `{ <rejected-count> = 1, error_message = 2 }`, the same shape for all three signals per the
 * `opentelemetry-proto` message definitions. `@ferrule/codecs` only ships decoders/encoders for
 * the *request* messages, so this response is encoded by hand with the same `ProtoWriter` those
 * encoders use.
 */
function encodeExportServiceResponse(rejectedCount: bigint, errorMessage: string): Uint8Array {
  if (rejectedCount === 0n && errorMessage === '') return new Uint8Array(0);
  const w = new ProtoWriter();
  w.writeMessage(1, (partial) => {
    if (rejectedCount !== 0n) partial.writeInt64(1, rejectedCount);
    if (errorMessage !== '') partial.writeString(2, errorMessage);
  });
  return w.finish();
}

function jsonExportServiceResponse(
  signal: OtlpSignal,
  rejectedCount: bigint,
  errorMessage: string,
): string {
  if (rejectedCount === 0n && errorMessage === '') return '{}';
  const partial: Record<string, string> = {};
  if (rejectedCount !== 0n) partial[rejectedCountJsonField(signal)] = rejectedCount.toString();
  if (errorMessage !== '') partial['errorMessage'] = errorMessage;
  return JSON.stringify({ partialSuccess: partial });
}

/** Encodes a `google.rpc.Status`-shaped error body (field 1 = `code` int32, field 2 = `message`
 * string; `details`, field 3, is never populated — this source has nothing structured to put
 * there). */
function encodeRpcStatus(code: number, message: string): Uint8Array {
  const w = new ProtoWriter();
  w.writeInt32(1, code);
  w.writeString(2, message);
  return w.finish();
}

function jsonRpcStatus(code: number, message: string): string {
  return JSON.stringify({ code, message });
}

function contentTypeFor(format: WireFormat): string {
  return format === 'protobuf' ? `${PROTOBUF_CONTENT_TYPE}` : `${JSON_CONTENT_TYPE}; charset=utf-8`;
}

function writeResponse(
  res: ServerResponse,
  status: number,
  format: WireFormat,
  body: Uint8Array | string,
  headers?: Record<string, string>,
): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  res.writeHead(status, {
    'content-type': contentTypeFor(format),
    'content-length': String(payload.length),
    ...headers,
  });
  res.end(payload);
}

/** Sends a full-request-failure response: a `google.rpc.Status` body in `format`, or JSON when
 * `format` is unknown (an unrecognised/missing Content-Type — we have no basis to guess which
 * body encoding the client would parse). */
function sendStatus(
  res: ServerResponse,
  format: WireFormat | undefined,
  httpStatus: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): void {
  const resolved = format ?? 'json';
  const body =
    resolved === 'protobuf' ? encodeRpcStatus(code, message) : jsonRpcStatus(code, message);
  writeResponse(res, httpStatus, resolved, body, headers);
}

/**
 * Sends a success response (always HTTP 200): the appropriate `Export<Signal>ServiceResponse`,
 * with `partial_success` populated only if `rejectedCount` is nonzero.
 *
 * Design note on `partial_success`: OTLP/HTTP's `partial_success` exists so a receiver can accept
 * an export while reporting that *some* of the records within it were dropped (e.g. one bad
 * record among a thousand good ones). This source's decoders (`@ferrule/codecs`'s OTLP decoders)
 * do not support that shape — a request's protobuf/JSON body is decoded to events or the decode
 * throws, atomically, with no partial result. Acknowledgement outcomes are likewise tracked per
 * *request* via a single `BatchNotifier` (matching `http_server`'s model), not per event, so
 * there is no per-record rejection count to attribute even after a downstream `'rejected'`
 * outcome — that case is reported as a whole-request 400 instead (see `RequestOutcome`
 * handling below), which is what the spec expects for a request that fails outright. In short:
 * this receiver treats each request as one atomic unit of work, so `partial_success` in practice
 * is always sent empty (equivalently: omitted) here. The encoder still accepts a nonzero count so
 * a future revision that can attribute partial rejection (e.g. a decoder that reports per-record
 * errors without failing the whole request) can populate it without changing this response shape.
 */
function sendSuccess(
  res: ServerResponse,
  format: WireFormat,
  signal: OtlpSignal,
  rejectedCount: bigint,
  errorMessage: string,
): void {
  const body =
    format === 'protobuf'
      ? encodeExportServiceResponse(rejectedCount, errorMessage)
      : jsonExportServiceResponse(signal, rejectedCount, errorMessage);
  writeResponse(res, 200, format, body);
}

// -------------------------------------------------------------------------------------------
// Decoding
// -------------------------------------------------------------------------------------------

function decodeBody(signal: OtlpSignal, format: WireFormat, body: Buffer): Event[] {
  if (format === 'protobuf') {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    switch (signal) {
      case 'logs':
        return decodeExportLogsServiceRequest(bytes);
      case 'metrics':
        return decodeExportMetricsServiceRequest(bytes);
      case 'traces':
        return decodeExportTraceServiceRequest(bytes);
    }
  }
  const text = body.toString('utf8');
  switch (signal) {
    case 'logs':
      return decodeOtlpJsonLogs(text);
    case 'metrics':
      return decodeOtlpJsonMetrics(text);
    case 'traces':
      return decodeOtlpJsonTraces(text);
  }
}

// -------------------------------------------------------------------------------------------
// Source
// -------------------------------------------------------------------------------------------

export const otlpSource = defineSource<OtlpOptions>({
  kind: 'source',
  type: 'otlp',
  description: 'Receives OTLP/HTTP log, metric, and trace exports (protobuf or OTLP/JSON).',
  options,
  produces: () => ['log', 'metric', 'span'],
  examples: [
    {
      title: 'Receive OTLP/HTTP exports on the default port',
      config: { address: '0.0.0.0:4318' },
    },
  ],
  build(opts, _buildCtx): OtlpSourceHandle {
    const maxCompressed = opts.max_compressed_body_size ?? opts.max_body_size;
    const base = opts.base_path.endsWith('/') ? opts.base_path.slice(0, -1) : opts.base_path;
    const routes: Record<string, OtlpSignal> = {
      [`${base}/logs`]: 'logs',
      [`${base}/metrics`]: 'metrics',
      [`${base}/traces`]: 'traces',
    };

    let boundAddress: { host: string; port: number } | undefined;

    async function run(ctx: SourceContext): Promise<void> {
      if (ctx.signal.aborted) return;
      const requestsErrored = ctx.metrics.counter(Metrics.errors);
      const requestsReceived = ctx.metrics.counter('otlp_requests_total');
      const requestsRejected = ctx.metrics.counter('otlp_requests_rejected_total');
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

      async function handleIngest(
        req: IncomingMessage,
        res: ServerResponse,
        signal: OtlpSignal,
      ): Promise<void> {
        const format = parseRequestFormat(req.headers['content-type']);
        if (format === undefined) {
          sendStatus(
            res,
            undefined,
            415,
            RpcCode.INVALID_ARGUMENT,
            'unsupported Content-Type; expected application/x-protobuf or application/json',
          );
          return;
        }

        const auth = checkAuth(req.headers.authorization, opts.auth);
        if (!auth.ok) {
          const headers = auth.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined;
          sendStatus(
            res,
            format,
            auth.status,
            auth.status === 401 ? RpcCode.UNAUTHENTICATED : RpcCode.PERMISSION_DENIED,
            auth.message,
            headers,
          );
          return;
        }

        const encoding = parseContentEncoding(req.headers['content-encoding']);
        if (encoding === undefined) {
          sendStatus(res, format, 415, RpcCode.INVALID_ARGUMENT, 'unsupported Content-Encoding');
          return;
        }

        let body: Buffer;
        try {
          // Deliberately not tied to `ctx.signal`: once a request's headers have been accepted
          // it is "in-flight work" per the component contract, and a graceful shutdown must let
          // it finish rather than cutting its body read short (see the `run()`-level comment on
          // `onAbort`).
          body = await readLimitedBody(req, {
            encoding,
            maxBytes: opts.max_body_size,
            maxCompressedBytes: maxCompressed,
          });
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            sendStatus(res, format, 413, RpcCode.RESOURCE_EXHAUSTED, error.message);
            return;
          }
          throw error;
        }

        let events: Event[];
        try {
          events = decodeBody(signal, format, body);
        } catch (error) {
          const message = error instanceof FerruleError ? error.message : String(error);
          sendStatus(res, format, 400, RpcCode.INVALID_ARGUMENT, message);
          return;
        }

        if (events.length === 0) {
          sendSuccess(res, format, signal, 0n, '');
          return;
        }

        const batch = new BatchNotifier();
        for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
        batch.seal();

        const sendPromise = ctx.output.send(events, DEFAULT_PORT);
        // Race against a plain timer, never `ctx.signal`: the output channel stays open and this
        // request is in-flight work that must be allowed to finish across a graceful shutdown, so
        // an abort here must not be treated as "the pipeline gave up". Only a genuine timeout, or
        // `sendPromise` itself settling, ends the race.
        let raceResult: 'sent' | 'timed_out';
        try {
          raceResult = await Promise.race([
            sendPromise.then((): 'sent' => 'sent'),
            ctx.clock.sleep(opts.backpressure_timeout).then((): 'timed_out' => 'timed_out'),
          ]);
        } catch (error) {
          ctx.logger.warn('otlp: send failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          sendStatus(res, format, 503, RpcCode.UNAVAILABLE, 'delivery failed; retry', {
            'retry-after': '1',
          });
          return;
        }
        if (raceResult === 'timed_out') {
          sendPromise.catch(() => {
            // Already reported to the client as unaccepted; nothing more to do here if the
            // pipeline later fails to admit the batch (its finalizers still resolve normally
            // when it does succeed, independent of this response).
          });
          sendStatus(
            res,
            format,
            503,
            RpcCode.UNAVAILABLE,
            'the pipeline is applying backpressure; retry later',
            { 'retry-after': String(retryAfterSeconds(opts.backpressure_timeout)) },
          );
          return;
        }

        if (!ctx.acknowledgements) {
          sendSuccess(res, format, signal, 0n, '');
          return;
        }

        const status: DeliveryStatus = await batch.completion;
        switch (status) {
          case 'delivered':
            sendSuccess(res, format, signal, 0n, '');
            return;
          case 'errored':
            sendStatus(
              res,
              format,
              503,
              RpcCode.UNAVAILABLE,
              'delivery failed transiently; retry',
              { 'retry-after': String(retryAfterSeconds(1000)) },
            );
            return;
          case 'rejected':
            sendStatus(
              res,
              format,
              400,
              RpcCode.INVALID_ARGUMENT,
              'delivery was permanently rejected',
            );
            return;
        }
      }

      async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const startedAt = ctx.clock.monotonic();
        activeRequests++;
        requestsReceived.increment();
        try {
          const url = new URL(req.url ?? '/', 'http://placeholder');
          if (req.method === 'GET' && url.pathname === opts.health_path) {
            const body = jsonRpcStatus(0, shuttingDown ? 'shutting_down' : 'ok');
            writeResponse(res, shuttingDown ? 503 : 200, 'json', body);
            return;
          }
          const signal = routes[url.pathname];
          if (signal === undefined) {
            sendStatus(res, undefined, 404, RpcCode.NOT_FOUND, 'no such route');
            return;
          }
          if (req.method !== 'POST') {
            sendStatus(res, undefined, 405, RpcCode.INVALID_ARGUMENT, 'expected POST', {
              allow: 'POST',
            });
            return;
          }
          if (activeRequests > opts.max_concurrent_requests) {
            requestsRejected.increment();
            sendStatus(
              res,
              undefined,
              429,
              RpcCode.RESOURCE_EXHAUSTED,
              'too many concurrent requests',
              { 'retry-after': '1' },
            );
            return;
          }
          await handleIngest(req, res, signal);
        } catch (error) {
          requestsErrored.increment();
          ctx.logger.error('otlp: request failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            sendStatus(res, undefined, 500, RpcCode.INTERNAL, 'internal error');
          }
        } finally {
          activeRequests--;
          requestDuration.record((ctx.clock.monotonic() - startedAt) / 1000);
          if (shuttingDown) server.closeIdleConnections();
        }
      }

      server.on('request', (req, res) => {
        handleRequest(req, res).catch((error: unknown) => {
          ctx.logger.error('otlp: unhandled request error', { error: String(error) });
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
      ctx.logger.info('otlp: listening', { address: boundAddress });

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

export default otlpSource;
