import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BatchNotifier, type DeliveryStatus, type Event } from '@ferrule/core';
import type { BuildContext, Logger, ManualClock } from '@ferrule/runtime';
import { createCapturingLogger, type CapturedLogRecord } from '@ferrule/runtime';

/** Attaches a fresh `BatchNotifier` (sealed) to `event` and returns the resulting completion
 * status promise, for asserting on the finalized delivery outcome of a single event. */
export function withNotifier<E extends Event>(
  event: E,
): { event: E; completion: Promise<DeliveryStatus> } {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return { event, completion: batch.completion };
}

/** A minimal `BuildContext` for calling a `SinkDefinition.build()` directly in tests. */
export function testBuildContext(id = 'test-sink'): {
  ctx: BuildContext;
  logger: Logger;
  logs: CapturedLogRecord[];
} {
  const { logger, records } = createCapturingLogger();
  return { ctx: { id, logger, dataDir: undefined, inputs: [] }, logger, logs: records };
}

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface TestServer {
  readonly url: string;
  readonly port: number;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

/** Reads a full request body into a `Buffer`. */
export function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Starts an in-process `node:http` server on `127.0.0.1:0` (an OS-assigned ephemeral port).
 * `handler` decides the response; every request it sees (with its body already buffered) is also
 * recorded in `requests` for assertions.
 */
export async function startServer(
  // Returns `unknown` rather than `void | Promise<void>` so a test handler can end with a bare
  // `res.end()` (which itself returns the `ServerResponse`) without an explicit `return;`.
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => unknown,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then(async (body) => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: { ...req.headers },
        body,
      });
      await handler(req, res, body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Drives a `ManualClock` forward one pending sleep at a time until `runPromise` settles (or
 * nothing is left pending), so a sink's retry backoff — which schedules its delay only once the
 * previous attempt has actually failed — resolves regardless of how many retries it takes or what
 * (randomised) delay each one picked.
 */
export async function drainRetries(
  clock: ManualClock,
  runPromise: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void runPromise.finally(() => {
    settled = true;
  });
  while (!settled) {
    const advanced = await clock.tick();
    if (!advanced) {
      // Nothing is scheduled *yet* — the in-flight attempt is real (if slow) async I/O that
      // hasn't failed and scheduled its retry sleep yet. Yield and check again rather than
      // giving up, until either a sleep appears to advance or `runPromise` settles.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await runPromise;
}
