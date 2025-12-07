import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isMetricEvent, type Event } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { prometheusScrapeSource, type PrometheusScrapeOptions } from '../src/prometheus_scrape.js';
import {
  createControllableSourceContext,
  waitUntil,
  type ControllableSourceHarness,
} from './support/context.js';

function buildCtx(id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir: undefined, inputs: [] };
}

type RawOptions = Record<string, unknown>;

async function start(rawOptions: RawOptions, acknowledgements = true) {
  const parsed: PrometheusScrapeOptions = prometheusScrapeSource.options.parse(rawOptions);
  const handle = await prometheusScrapeSource.build(parsed, buildCtx());
  const harness = createControllableSourceContext({ acknowledgements });
  const runPromise = handle.run(harness.ctx);
  return {
    harness,
    runPromise,
    async stop(): Promise<void> {
      harness.releaseSends();
      harness.abort();
      await runPromise;
    },
  };
}

const runningSources: { stop(): Promise<void> }[] = [];
const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(runningSources.splice(0).map((s) => s.stop()));
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startTracked(rawOptions: RawOptions, acknowledgements = true) {
  const started = await start(rawOptions, acknowledgements);
  runningSources.push(started);
  return started;
}

async function makeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer(handler);
  runningServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}/metrics`, port: addr.port };
}

/** A port nothing is listening on, for a "connection refused" scrape target: bind then close. */
async function closedPort(): Promise<number> {
  const { server, port } = await makeServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runningServers.splice(runningServers.indexOf(server), 1);
  return port;
}

function textResponder(body: string, status = 200) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(body);
  };
}

function finishAll(events: readonly Event[]): void {
  for (const event of events) event.metadata.finalizers.finish('delivered');
}

function counterValue(
  harness: ControllableSourceHarness,
  name: string,
  tagFilter?: Record<string, string>,
): number {
  const match = harness.metrics
    .snapshot()
    .filter(isMetricEvent)
    .find(
      (e) =>
        e.name === name &&
        (tagFilter === undefined ||
          Object.entries(tagFilter).every(([k, v]) => e.tags.get(k) === v)),
    );
  return match !== undefined && match.value.type === 'counter' ? match.value.value : 0;
}

const COUNTER_BODY = '# TYPE http_requests_total counter\nhttp_requests_total 42\n';

describe('prometheus_scrape: happy path', () => {
  it('scrapes, decodes, and tags events with instance/job from the target config', async () => {
    const { url, port } = await makeServer(textResponder(COUNTER_BODY));
    const { harness } = await startTracked({
      targets: [{ url, job: 'my_job', instance: 'my_instance' }],
    });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('http_requests_total');
    expect(events[0]!.value).toEqual({ type: 'counter', value: 42 });
    expect(events[0]!.tags.get('job')).toBe('my_job');
    expect(events[0]!.tags.get('instance')).toBe('my_instance');
    void port;
    finishAll(events);
  });

  it('defaults instance to the target URL host:port and job to a sensible default', async () => {
    const { url, port } = await makeServer(textResponder(COUNTER_BODY));
    const { harness } = await startTracked({ targets: [{ url }] });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.tags.get('instance')).toBe(`127.0.0.1:${port}`);
    expect(events[0]!.tags.get('job')).toBeTypeOf('string');
    finishAll(events);
  });

  it('with honorLabels: true, preserves an existing instance label from the scraped body', async () => {
    const body = '# TYPE up gauge\nup{instance="custom-instance"} 1\n';
    const { url } = await makeServer(textResponder(body));
    const { harness } = await startTracked({
      targets: [{ url, job: 'my_job', instance: 'config-instance' }],
      honorLabels: true,
    });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.tags.get('instance')).toBe('custom-instance');
    // job was absent from the scraped body, so honorLabels still fills it in from config.
    expect(events[0]!.tags.get('job')).toBe('my_job');
    finishAll(events);
  });

  it('with honorLabels: false (default), overwrites an existing instance label from the body', async () => {
    const body = '# TYPE up gauge\nup{instance="custom-instance"} 1\n';
    const { url } = await makeServer(textResponder(body));
    const { harness } = await startTracked({
      targets: [{ url, job: 'my_job', instance: 'config-instance' }],
    });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.tags.get('instance')).toBe('config-instance');
    finishAll(events);
  });
});

describe('prometheus_scrape: per-target failures', () => {
  it('a connection-refused target fails without blocking a working target in the same round', async () => {
    const { url: goodUrl } = await makeServer(textResponder(COUNTER_BODY));
    const badPort = await closedPort();
    const badUrl = `http://127.0.0.1:${badPort}/metrics`;
    const { harness } = await startTracked({
      targets: [
        { url: goodUrl, job: 'good' },
        { url: badUrl, job: 'bad' },
      ],
    });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.tags.get('job')).toBe('good');
    finishAll(events);
    await waitUntil(
      () => counterValue(harness, 'prometheus_scrape_failures_total', { target: badUrl }) === 1,
    );
  });

  it('a non-200 status fails without blocking a working target in the same round', async () => {
    const { url: goodUrl } = await makeServer(textResponder(COUNTER_BODY));
    const { url: badUrl } = await makeServer(textResponder('internal error', 500));
    const { harness } = await startTracked({
      targets: [
        { url: goodUrl, job: 'good' },
        { url: badUrl, job: 'bad' },
      ],
    });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.tags.get('job')).toBe('good');
    finishAll(events);
    await waitUntil(
      () => counterValue(harness, 'prometheus_scrape_failures_total', { target: badUrl }) === 1,
    );
  });

  it('a malformed body fails without blocking a working target in the same round', async () => {
    const { url: goodUrl } = await makeServer(textResponder(COUNTER_BODY));
    const { url: badUrl } = await makeServer(textResponder('not { valid = prometheus text'));
    const { harness } = await startTracked({
      targets: [
        { url: goodUrl, job: 'good' },
        { url: badUrl, job: 'bad' },
      ],
    });
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isMetricEvent);
    expect(events[0]!.tags.get('job')).toBe('good');
    finishAll(events);
    await waitUntil(
      () => counterValue(harness, 'prometheus_scrape_failures_total', { target: badUrl }) === 1,
    );
  });

  it('aborts a target that never responds after scrapeTimeoutMs', async () => {
    const { url } = await makeServer((_req, _res) => {
      // Never calls res.end(): the request hangs until the client gives up.
    });
    const { harness } = await startTracked({
      targets: [{ url }],
      scrapeTimeoutMs: 100,
    });
    await waitUntil(
      () => counterValue(harness, 'prometheus_scrape_failures_total', { target: url }) === 1,
      200_000,
    );
    expect(harness.sent).toHaveLength(0);
  });
});

describe('prometheus_scrape: concurrency', () => {
  it('bounds the number of targets scraped in parallel within one round', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseAll: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const targets: { url: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const { url } = await makeServer((_req, res) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        void gate.then(() => {
          inFlight--;
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(`# TYPE m${i} counter\nm${i} 1\n`);
        });
      });
      targets.push({ url });
    }

    const { harness } = await startTracked({ targets, concurrency: 2 }, false);
    await waitUntil(() => inFlight === 2);
    // Give any over-eager extra requests a chance to arrive before asserting the bound held.
    await new Promise((resolve) => setImmediate(resolve));
    expect(inFlight).toBe(2);
    releaseAll!();
    await waitUntil(() => harness.sent.length === 4);
    expect(maxInFlight).toBe(2);
  });
});

describe('prometheus_scrape: interval loop', () => {
  it('runs additional rounds as ManualClock is advanced, and stops after graceful shutdown', async () => {
    let scrapeCount = 0;
    const { url } = await makeServer((_req, res) => {
      scrapeCount++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(COUNTER_BODY);
    });
    const { harness, runPromise } = await startTracked({
      targets: [{ url }],
      intervalMs: 1000,
    });

    await waitUntil(() => harness.sent.length === 1);
    finishAll(harness.sent[0]!.events);
    expect(scrapeCount).toBe(1);

    // Wait until the loop is actually parked in the between-rounds sleep before advancing the
    // clock past it — advancing too early (while the round-1 batch's completion is still
    // resolving through microtasks) would race ahead of the sleep being registered.
    await waitUntil(() => harness.clock.pendingCount > 0);
    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 2);
    finishAll(harness.sent[1]!.events);
    expect(scrapeCount).toBe(2);

    await waitUntil(() => harness.clock.pendingCount > 0);
    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 3);
    finishAll(harness.sent[2]!.events);
    expect(scrapeCount).toBe(3);

    harness.abort();
    await runPromise;

    const countAfterShutdown = scrapeCount;
    await harness.clock.advance(1000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(scrapeCount).toBe(countAfterShutdown);
  });
});
