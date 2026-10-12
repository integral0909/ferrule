/**
 * Throughput benchmark for running a CPU-bound Ferrule Script program across several
 * `worker_threads`, showing that splitting work across workers actually scales throughput (see
 * `docs/architecture.md` §4.3 and `packages/runtime/README.md`'s "Worker pool"). This exercises
 * `@ferrule/script`'s `compile`/`run` directly, across real worker threads spawned from this
 * same file (a worker's `workerData.role === 'worker'` makes it re-run this module as a worker
 * instead of the benchmark driver) — not `@ferrule/operators`' `script` transform, so this stays
 * within `@ferrule/script`'s own dependencies (`@ferrule/core` only; `script` sits below
 * `runtime`/`operators` in the dependency graph, and a benchmark is not an exception to that).
 * The mechanism is the same one `@ferrule/operators`' `script` transform's `workers: <n>` option
 * builds on `@ferrule/runtime`'s `WorkerPool` for: compile the program once per worker, then run
 * it many times without recompiling.
 *
 * Run with:
 *   node --experimental-strip-types packages/script/bench/worker-pool-throughput.ts
 * or, from inside the monorepo where tsx/vitest are available:
 *   pnpm exec tsx packages/script/bench/worker-pool-throughput.ts
 *
 * Not part of CI — see the package README's "Benchmark" section.
 */
import { cpus } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { LogEvent } from '@ferrule/core';
import { compile, parseAndCheck } from '@ferrule/script';

/**
 * Deliberately CPU-bound: a hash chain, a regex scan, and a sort, all over a message long
 * enough (see `sampleMessage`) that each of these costs something real per event rather than
 * being swamped by fixed per-event overhead (frame allocation, context setup) the way a trivial
 * program would be.
 */
const PROGRAM = `
.digest = sha256(.message) ?? ""
.digest = sha256(.digest) ?? ""
.words = split(.message, " ") ?? []
.sorted = sort(.words) ?? []
.joined = join(.sorted, ",") ?? ""
.numbers = parse_regex_all(.message, "[0-9]+") ?? []
.shout = upcase(.message) ?? .message
`;

const WORDS = [
  'gateway',
  'checkout',
  'inventory',
  'billing',
  'request',
  'completed',
  'retrying',
  'upstream',
  'connection',
  'established',
  'cache',
  'miss',
  'slow',
  'query',
  'detected',
  'rate',
  'limit',
  'exceeded',
  'user',
  'authenticated',
];

/** A realistic-length log message (a couple hundred characters), deterministic in `i`. */
function sampleMessage(i: number): string {
  const parts: string[] = [];
  for (let w = 0; w < 24; w++) parts.push(WORDS[(i + w * 7) % WORDS.length]!);
  parts.push(`id-${i}`, `code-${(i * 37) % 999}`, `latency-${(i * 13) % 5000}ms`);
  return parts.join(' ');
}

function sampleEvent(i: number): LogEvent {
  return LogEvent.from({ message: sampleMessage(i) });
}

function compileProgram(): ReturnType<typeof compile> {
  const checked = parseAndCheck(PROGRAM);
  const errors = [...checked.parseDiagnostics, ...checked.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    throw new Error(`benchmark program has errors: ${errors.map((d) => d.message).join('; ')}`);
  }
  return compile(checked);
}

// --- Worker role: run `count` events starting at `startIndex`, report elapsed time -------------

interface WorkerRequest {
  readonly role: 'worker';
  readonly startIndex: number;
  readonly count: number;
}

if (!isMainThread && (workerData as WorkerRequest | undefined)?.role === 'worker') {
  const { startIndex, count } = workerData as WorkerRequest;
  const program = compileProgram();
  const start = performance.now();
  for (let i = 0; i < count; i++) program.run(sampleEvent(startIndex + i));
  const elapsedMs = performance.now() - start;
  parentPort!.postMessage({ elapsedMs });
}

// --- Driver --------------------------------------------------------------------------------

async function runWithWorkers(totalEvents: number, workerCount: number): Promise<number> {
  const perWorker = Math.ceil(totalEvents / workerCount);
  const start = performance.now();
  await Promise.all(
    Array.from({ length: workerCount }, (_, w) => {
      const startIndex = w * perWorker;
      const count = Math.max(0, Math.min(perWorker, totalEvents - startIndex));
      if (count === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { role: 'worker', startIndex, count } satisfies WorkerRequest,
        });
        worker.on('message', () => {
          void worker.terminate().then(() => resolve(), reject);
        });
        worker.on('error', reject);
      });
    }),
  );
  const elapsedMs = performance.now() - start;
  return (totalEvents / elapsedMs) * 1000;
}

function runInThread(totalEvents: number): number {
  const program = compileProgram();
  const start = performance.now();
  for (let i = 0; i < totalEvents; i++) program.run(sampleEvent(i));
  const elapsedMs = performance.now() - start;
  return (totalEvents / elapsedMs) * 1000;
}

async function main(): Promise<void> {
  const availableCores = cpus().length;
  // eslint-disable-next-line no-console -- a benchmark script's whole job is printing results
  console.log(`machine: ${availableCores} logical cores\n`);

  const totalEvents = 200_000;

  const baseline = runInThread(totalEvents);
  // eslint-disable-next-line no-console
  console.log(
    `in-thread (no workers)      ${totalEvents.toString().padStart(9)} events` +
      `  ${Math.round(baseline).toLocaleString().padStart(12)} events/sec`,
  );

  const workerCounts = [...new Set([1, 2, 4, availableCores])].filter((n) => n >= 1);
  for (const workerCount of workerCounts) {
    const rate = await runWithWorkers(totalEvents, workerCount);
    const speedup = rate / baseline;
    // eslint-disable-next-line no-console
    console.log(
      `${workerCount.toString().padStart(2)} worker(s)                  ${totalEvents
        .toString()
        .padStart(9)} events` +
        `  ${Math.round(rate).toLocaleString().padStart(12)} events/sec` +
        `  (${speedup.toFixed(2)}x in-thread)`,
    );
  }
}

if (isMainThread) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
