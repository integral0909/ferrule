import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkerPool,
  WorkerPoolClosedError,
  WorkerPoolCrashedError,
  type WorkerPoolOptions,
} from '@ferrule/runtime';

/**
 * Covers `WorkerPool` directly, against `fixtures/worker-pool-fixture.ts` (a dependency-free
 * worker entry so these tests don't need the `@ferrule/source` resolution condition — see that
 * fixture's doc and `worker-pool.ts`'s `resolveWorkerEntry`). `operators/test/script.test.ts`
 * covers the `script` transform's `workers` option end to end, including the production-style
 * entry resolution.
 */

const FIXTURE_URL = new URL('./fixtures/worker-pool-fixture.ts', import.meta.url);
const EXEC_ARGV = ['--experimental-strip-types'];

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

describe('WorkerPool', () => {
  const pools: Array<WorkerPool<unknown, unknown>> = [];
  function makePool<Init>(init: Init, workerCount = 1, maxQueueDepth?: number): WorkerPool<Init> {
    const options: WorkerPoolOptions<Init> = {
      url: FIXTURE_URL,
      execArgv: EXEC_ARGV,
      workerCount,
      init,
      ...(maxQueueDepth !== undefined ? { maxQueueDepth } : {}),
    };
    const pool = new WorkerPool<Init>(options);
    pools.push(pool);
    return pool;
  }

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.close().catch(() => undefined)));
  });

  it('round-trips a payload and meta through a worker', async () => {
    const pool = makePool({ behavior: 'echo' });
    const response = await pool.submit({ meta: { tag: 'a' }, payload: bytes('hello') });
    expect(text(response.payload)).toBe('HELLO');
    expect(response.meta).toEqual({ tag: 'a', seen: true });
  });

  it('runs independent requests across several workers concurrently', async () => {
    const pool = makePool({ behavior: 'echo' }, 4);
    const results = await Promise.all(
      ['one', 'two', 'three', 'four'].map((s) => pool.submit({ meta: {}, payload: bytes(s) })),
    );
    expect(results.map((r) => text(r.payload))).toEqual(['ONE', 'TWO', 'THREE', 'FOUR']);
  });

  it('queues requests past the worker count and dispatches them as workers free up', async () => {
    const pool = makePool({ behavior: 'echo' }, 1, 5);
    const submissions = ['a', 'b', 'c'].map((s) =>
      pool.submit({ meta: { delayMs: 10 }, payload: bytes(s) }),
    );
    const results = await Promise.all(submissions);
    expect(results.map((r) => text(r.payload))).toEqual(['A', 'B', 'C']);
  });

  it('retries once on a fresh worker after a crash, and the request still succeeds', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'ferrule-worker-pool-'));
    const pool = makePool({ behavior: 'crash-once', markerDir }, 1);
    const response = await pool.submit({
      meta: { requestKey: 'req-1' },
      payload: bytes('retry-me'),
    });
    expect(text(response.payload)).toBe('RETRY-ME');
    expect(pool.stats.workers).toBe(1);
  });

  it('gives up after a second crash and rejects with WorkerPoolCrashedError', async () => {
    const pool = makePool({ behavior: 'always-crash' }, 1);
    await expect(pool.submit({ meta: {}, payload: bytes('x') })).rejects.toBeInstanceOf(
      WorkerPoolCrashedError,
    );
    // The pool keeps a healthy worker running for later requests.
    expect(pool.stats.workers).toBe(1);
  });

  it('an application-level error response rejects without treating it as a crash', async () => {
    const pool = makePool({ behavior: 'reject' }, 1);
    await expect(pool.submit({ meta: {}, payload: bytes('x') })).rejects.toThrow(
      'deliberate reject',
    );
    // A second request on the same (still-alive) worker also gets the clean rejection, not a
    // WorkerPoolCrashedError — proof the worker was never treated as crashed.
    await expect(pool.submit({ meta: {}, payload: bytes('y') })).rejects.toThrow(
      'deliberate reject',
    );
  });

  it('close() waits for an in-flight request, rejects a still-queued one, then terminates workers', async () => {
    const pool = makePool({ behavior: 'echo' }, 1, 5);
    const inFlight = pool.submit({ meta: { delayMs: 50 }, payload: bytes('slow') });
    // Give the first request a moment to actually be dispatched before queuing the second.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = pool.submit({ meta: {}, payload: bytes('never-runs') });

    const closePromise = pool.close();
    await expect(queued).rejects.toBeInstanceOf(WorkerPoolClosedError);
    const result = await inFlight;
    expect(text(result.payload)).toBe('SLOW');
    await closePromise;

    await expect(pool.submit({ meta: {}, payload: bytes('z') })).rejects.toBeInstanceOf(
      WorkerPoolClosedError,
    );
  });

  it('rejects an abort signal while still queued, without affecting the dispatched request', async () => {
    const pool = makePool({ behavior: 'echo' }, 1, 5);
    const busy = pool.submit({ meta: { delayMs: 30 }, payload: bytes('busy') });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const controller = new AbortController();
    const aborted = pool.submit({ meta: {}, payload: bytes('cancel-me') }, controller.signal);
    controller.abort(new Error('caller gave up'));
    await expect(aborted).rejects.toThrow('caller gave up');
    const result = await busy;
    expect(text(result.payload)).toBe('BUSY');
  });
});
