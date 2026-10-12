import { Worker, parentPort } from 'node:worker_threads';
import { FerruleError } from '@ferrule/core';

/**
 * A pool of `worker_threads` for CPU-heavy work, built so the payload crossing the thread
 * boundary is a `Uint8Array` the caller already encoded (with `@ferrule/buffer`'s binary event
 * codec, for `script`'s use — see `packages/operators/src/worker/script-worker-entry.ts`) rather
 * than a JavaScript object structured-cloning would have to walk. See `docs/architecture.md`
 * §4.3 and this package's README for the design.
 *
 * What this module does *not* know about: events, finalizers, or Ferrule Script. It only moves
 * `{ meta, payload }` pairs to and from a fixed set of worker threads, each running the same
 * entry module, keyed by an internally assigned request id. `meta` is small, structured-cloned
 * control data (e.g. "which original event index does this chunk start at"); `payload` is the
 * bulk bytes, moved by transfer, not copy, on the wire — see `submit`'s doc for the one copy this
 * pool does keep, and why.
 */

// -------------------------------------------------------------------------------------------
// Wire protocol (also used directly by a worker entry module via `runWorkerPoolHandler`)
// -------------------------------------------------------------------------------------------

/** Sent from the pool to a worker. */
export interface WorkerPoolRequestMessage<Meta> {
  readonly type: 'ferrule:request';
  readonly id: number;
  readonly meta: Meta;
  readonly payload: ArrayBuffer;
}

/** Sent from a worker back to the pool: a successful result. */
export interface WorkerPoolResponseMessage<Meta> {
  readonly type: 'ferrule:response';
  readonly id: number;
  readonly meta: Meta;
  readonly payload: ArrayBuffer;
}

/**
 * Sent from a worker back to the pool: the handler itself failed on this particular request
 * (the worker is still alive and goes back in the idle set — this is not a crash, so there is no
 * retry; see the module doc and `WorkerPool`'s crash-handling section for the distinction).
 */
export interface WorkerPoolErrorMessage {
  readonly type: 'ferrule:error';
  readonly id: number;
  readonly message: string;
}

export type WorkerPoolOutboundMessage<Meta> =
  WorkerPoolResponseMessage<Meta> | WorkerPoolErrorMessage;

/**
 * An exactly-sized, standalone `ArrayBuffer` backing `view`, safe to transfer whole: `view`
 * itself if it already spans its entire (plain `ArrayBuffer`) buffer with no offset, otherwise a
 * fresh copy via `slice()`. Every `Uint8Array` this module ever transfers is produced by one of
 * `@ferrule/buffer`'s codec functions or `slice()` itself, both of which only ever hand back a
 * plain `ArrayBuffer` — never a `SharedArrayBuffer`, which is a distinct, non-`Transferable` type
 * `Uint8Array.prototype.buffer`'s type must account for but this module never actually produces.
 */
function exactArrayBuffer(view: Uint8Array): ArrayBuffer {
  const sized =
    view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
  return sized.buffer as ArrayBuffer;
}

/**
 * Wires a worker entry module's `parentPort` to call `handler` for every request and post its
 * result back with the matching id, transferring the response payload's buffer. Call this once,
 * after the entry module has done its one-time setup (e.g. compiling a program from the init
 * payload in `workerData`). `handler`'s `payload.buffer` must be exactly `payload.byteLength`
 * long (e.g. produced by `Uint8Array.prototype.slice`, as every codec function here does) since
 * it is transferred whole.
 */
export function runWorkerPoolHandler<Meta>(
  handler: (
    meta: Meta,
    payload: Uint8Array,
  ) => { meta: Meta; payload: Uint8Array } | Promise<{ meta: Meta; payload: Uint8Array }>,
): void {
  if (parentPort === null) {
    throw new FerruleError(
      'E_NOT_IN_WORKER',
      'runWorkerPoolHandler must be called from inside a worker_threads worker',
    );
  }
  const port = parentPort;
  port.on('message', (msg: WorkerPoolRequestMessage<Meta>) => {
    if (msg.type !== 'ferrule:request') return;
    Promise.resolve()
      .then(() => handler(msg.meta, new Uint8Array(msg.payload)))
      .then((result) => {
        const buffer = exactArrayBuffer(result.payload);
        const response: WorkerPoolResponseMessage<Meta> = {
          type: 'ferrule:response',
          id: msg.id,
          meta: result.meta,
          payload: buffer,
        };
        port.postMessage(response, [buffer]);
      })
      .catch((error: unknown) => {
        const response: WorkerPoolErrorMessage = {
          type: 'ferrule:error',
          id: msg.id,
          message: error instanceof Error ? error.message : String(error),
        };
        port.postMessage(response);
      });
  });
}

// -------------------------------------------------------------------------------------------
// Entry resolution (dist vs src, see README "Worker entry resolution")
// -------------------------------------------------------------------------------------------

/**
 * Resolves a worker entry module's URL and the `execArgv` a `Worker` needs to run it, given the
 * `import.meta.url` of the module constructing the pool (`callerUrl`) and the entry's path
 * relative to that module's package's `src/` directory (`entryRelativePath`, e.g.
 * `'worker/script-worker-entry.ts'`).
 *
 * Worker entry modules always run from TypeScript *source*, in both environments, using Node's
 * `--experimental-strip-types` (the same flag the `script` and `runtime` packages' own
 * benchmarks already run with — see `packages/script/bench/throughput.ts`): a package ships both
 * `dist/` (built JS) and `src/` (TypeScript) — see any package's `package.json` `files` — so the
 * entry's source is always present, and type-stripping it at worker startup is a one-time cost
 * per long-lived worker, not a per-batch one.
 *
 * What differs between "running from a built `dist/`" (production) and "running from `src/`"
 * (this monorepo's own tests, via Vitest's alias, or an unbuilt workspace checkout) is how the
 * entry's *own* imports of other `@ferrule/*` packages resolve: in production those packages are
 * built too, so the default `exports` condition (→ `dist/index.js`) is correct and fast; from
 * source, nothing is built, so the worker also needs `--conditions=@ferrule/source` (the same
 * custom condition `tsconfig.base.json`'s `customConditions` already uses for type-checking) to
 * resolve its imports to *their* `src/index.ts` too. `callerUrl`'s own immediate parent directory
 * name (`src` or `dist`) says which situation this is, since `dist/` mirrors `src/` file for
 * file — this is why `callerUrl` must be a module directly inside its package's `src`/`dist`,
 * not nested further: one directory above it is always that package's root.
 */
export function resolveWorkerEntry(
  callerUrl: string | URL,
  entryRelativePath: string,
): { readonly url: URL; readonly execArgv: readonly string[] } {
  const caller = typeof callerUrl === 'string' ? new URL(callerUrl) : callerUrl;
  const segments = caller.pathname.split('/');
  const parentDir = segments[segments.length - 2];
  if (parentDir !== 'src' && parentDir !== 'dist') {
    throw new FerruleError(
      'E_WORKER_ENTRY_LAYOUT',
      `resolveWorkerEntry: ${caller.href} is not directly inside a package's src/ or dist/ ` +
        'directory, so the package root cannot be found one level up',
    );
  }
  const packageRoot = new URL('../', caller);
  const url = new URL(`src/${entryRelativePath}`, packageRoot);
  const execArgv =
    parentDir === 'src'
      ? ['--experimental-strip-types', '--conditions=@ferrule/source']
      : ['--experimental-strip-types'];
  return { url, execArgv };
}

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** Raised when `submit` is called after `close`, or while `close` is draining the queue. */
export class WorkerPoolClosedError extends FerruleError {
  constructor() {
    super('E_WORKER_POOL_CLOSED', 'worker pool is closed');
    this.name = 'WorkerPoolClosedError';
  }
}

/**
 * Raised when a request's worker crashed twice in a row (the original attempt and one retry on
 * a fresh worker). The caller decides what this means for the data it submitted — for `script`,
 * finishing the chunk's events `errored` (see `packages/operators/README.md`).
 */
export class WorkerPoolCrashedError extends FerruleError {
  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      'E_WORKER_POOL_CRASHED',
      `worker crashed (attempt ${attempts}/2); giving up on this request`,
      { cause },
    );
    this.name = 'WorkerPoolCrashedError';
  }
}

// -------------------------------------------------------------------------------------------
// Pool
// -------------------------------------------------------------------------------------------

export interface WorkerPoolRequest<Meta = unknown> {
  readonly meta: Meta;
  /** Transferred, not copied, on the wire — but never detached on the caller's side; see `submit`. */
  readonly payload: Uint8Array;
}

export interface WorkerPoolResponse<Meta = unknown> {
  readonly meta: Meta;
  readonly payload: Uint8Array;
}

export interface WorkerPoolOptions<Init> {
  /** The worker entry module's URL — see {@link resolveWorkerEntry}. */
  readonly url: URL;
  /** Number of worker threads to keep running. */
  readonly workerCount: number;
  /** Sent to every worker once, as `workerData`, for one-time setup (e.g. compiling a program). */
  readonly init: Init;
  /** CLI flags for every worker — see {@link resolveWorkerEntry}. */
  readonly execArgv?: readonly string[];
  /**
   * Maximum number of requests queued waiting for a free worker, beyond the `workerCount`
   * already dispatched. `submit` waits for space rather than rejecting when this is hit — the
   * same "bounded, backpressured" shape as `EventChannel`. Default: `workerCount * 4`.
   */
  readonly maxQueueDepth?: number;
}

interface PendingRequest<Meta> {
  readonly request: WorkerPoolRequest<Meta>;
  attempts: number;
  settled: boolean;
  resolve(response: WorkerPoolResponse<Meta>): void;
  reject(reason: unknown): void;
}

interface WorkerSlot<Meta> {
  worker: Worker;
  /** The request currently dispatched to this worker, if any. */
  current: { id: number; pending: PendingRequest<Meta> } | undefined;
}

/** @see the module doc. */
export class WorkerPool<Init, Meta = unknown> {
  private readonly slots: WorkerSlot<Meta>[] = [];
  private readonly idle: WorkerSlot<Meta>[] = [];
  private readonly queue: PendingRequest<Meta>[] = [];
  private readonly maxQueueDepth: number;
  private readonly spaceWaiters = new Set<() => void>();
  private readonly drainWaiters: Array<() => void> = [];
  private readonly allPending = new Set<PendingRequest<Meta>>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: WorkerPoolOptions<Init>) {
    this.maxQueueDepth = options.maxQueueDepth ?? options.workerCount * 4;
    for (let i = 0; i < options.workerCount; i++) {
      const slot: WorkerSlot<Meta> = { worker: this.spawn(), current: undefined };
      this.wire(slot);
      this.slots.push(slot);
      this.idle.push(slot);
    }
  }

  get stats(): { readonly workers: number; readonly idle: number; readonly queued: number } {
    return { workers: this.slots.length, idle: this.idle.length, queued: this.queue.length };
  }

  private spawn(): Worker {
    const init: { execArgv?: string[]; workerData: Init } = { workerData: this.options.init };
    if (this.options.execArgv !== undefined) init.execArgv = [...this.options.execArgv];
    return new Worker(this.options.url, init);
  }

  /**
   * Attaches this worker generation's listeners, each scoped to `worker` (captured here, not
   * read back off `slot` later): once a crash replaces `slot.worker`, a straggling event from
   * the dead worker — Node fires both `'error'` and a non-zero `'exit'` for one uncaught
   * exception — finds `slot.worker !== worker` and is ignored, instead of mistakenly re-crashing
   * the fresh replacement that already took its place.
   */
  private wire(slot: WorkerSlot<Meta>): void {
    const worker = slot.worker;
    worker.on('message', (msg: WorkerPoolOutboundMessage<Meta>) => {
      if (slot.worker !== worker) return;
      const current = slot.current;
      if (current === undefined || current.id !== msg.id) return;
      slot.current = undefined;
      if (msg.type === 'ferrule:response') {
        current.pending.resolve({ meta: msg.meta, payload: new Uint8Array(msg.payload) });
      } else {
        current.pending.reject(new FerruleError('E_WORKER_POOL_HANDLER', msg.message));
      }
      this.idle.push(slot);
      this.trySchedule();
    });
    worker.on('error', (error) => {
      if (slot.worker !== worker) return;
      this.handleCrash(slot, error);
    });
    worker.on('exit', (code) => {
      if (slot.worker !== worker) return;
      if (code !== 0) this.handleCrash(slot, new Error(`worker exited with code ${code}`));
    });
  }

  private handleCrash(slot: WorkerSlot<Meta>, cause: unknown): void {
    const idleIndex = this.idle.indexOf(slot);
    if (idleIndex !== -1) this.idle.splice(idleIndex, 1);

    const current = slot.current;
    slot.current = undefined;
    slot.worker = this.spawn();
    this.wire(slot);
    this.idle.push(slot);

    if (current !== undefined) {
      const { pending } = current;
      if (pending.attempts >= 2) {
        pending.reject(new WorkerPoolCrashedError(pending.attempts, cause));
      } else {
        // Retried once, on whichever worker is free next (the fresh replacement above, or
        // another already-idle one) — either way, not the one that just crashed.
        this.queue.unshift(pending);
      }
    }
    this.trySchedule();
  }

  private trySchedule(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const pending = this.queue.shift()!;
      const slot = this.idle.shift()!;
      this.notifySpaceWaiters();
      this.dispatch(slot, pending);
    }
  }

  private dispatch(slot: WorkerSlot<Meta>, pending: PendingRequest<Meta>): void {
    pending.attempts++;
    const id = this.nextId++;
    slot.current = { id, pending };
    // `.slice()` keeps the caller's own `payload` intact (see `submit`'s doc) and gives us an
    // exactly-sized, standalone buffer to transfer — no structured clone of event data, one
    // memcpy per dispatch (two if this request is ever retried).
    const buffer = exactArrayBuffer(pending.request.payload.slice());
    const message: WorkerPoolRequestMessage<Meta> = {
      type: 'ferrule:request',
      id,
      meta: pending.request.meta,
      payload: buffer,
    };
    slot.worker.postMessage(message, [buffer]);
  }

  private settle(pending: PendingRequest<Meta>, fn: () => void): void {
    if (pending.settled) return;
    pending.settled = true;
    this.allPending.delete(pending);
    fn();
    if (this.allPending.size === 0) {
      const waiters = this.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
  }

  private notifySpaceWaiters(): void {
    for (const waiter of [...this.spaceWaiters]) waiter();
  }

  private waitForQueueSpace(signal?: AbortSignal): Promise<void> {
    if (this.queue.length < this.maxQueueDepth || this.closed) return Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
    if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (this.queue.length >= this.maxQueueDepth && !this.closed) return;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(signal!.reason as unknown);
      };
      const cleanup = (): void => {
        this.spaceWaiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
      };
      this.spaceWaiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Submits one request, waiting for queue space (if the bound is hit) and then for a free
   * worker. Resolves with the worker's result, or rejects with {@link WorkerPoolCrashedError}
   * after two failed attempts, with whatever error the handler itself reported (not a crash —
   * the worker stays in the pool), or with `signal`'s abort reason if it fires while this request
   * is still queued (once dispatched to a worker, `signal` is no longer honoured — killing a
   * worker mid-batch would corrupt, not cancel, its work; see the README).
   *
   * `request.payload` is read, not detached: this pool always transfers a `.slice()` copy, so the
   * caller's own `Uint8Array` stays valid and can be reused (this is also what lets a crashed
   * request be retried without the caller doing anything).
   */
  async submit(
    request: WorkerPoolRequest<Meta>,
    signal?: AbortSignal,
  ): Promise<WorkerPoolResponse<Meta>> {
    if (this.closed) throw new WorkerPoolClosedError();
    if (signal?.aborted === true) throw signal.reason as unknown;

    while (this.queue.length >= this.maxQueueDepth) {
      if (this.closed) throw new WorkerPoolClosedError();
      await this.waitForQueueSpace(signal);
    }
    if (this.closed) throw new WorkerPoolClosedError();

    return new Promise<WorkerPoolResponse<Meta>>((resolveOuter, rejectOuter) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(pending);
        if (index === -1) return; // already dispatched; let it run to completion
        this.queue.splice(index, 1);
        pending.reject(signal!.reason as unknown);
      };
      const pending: PendingRequest<Meta> = {
        request,
        attempts: 0,
        settled: false,
        resolve: (response) => {
          signal?.removeEventListener('abort', onAbort);
          this.settle(pending, () => resolveOuter(response));
        },
        reject: (reason) => {
          signal?.removeEventListener('abort', onAbort);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's/handler's reason as-is
          this.settle(pending, () => rejectOuter(reason));
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.allPending.add(pending);
      this.queue.push(pending);
      this.trySchedule();
    });
  }

  /**
   * Graceful shutdown: rejects every request still only queued (never dispatched to a worker)
   * with {@link WorkerPoolClosedError}, waits for every already-dispatched request to settle
   * naturally, then terminates every worker thread. Further `submit` calls reject immediately.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.notifySpaceWaiters();
    const stillQueued = this.queue.splice(0);
    for (const pending of stillQueued) pending.reject(new WorkerPoolClosedError());
    if (this.allPending.size > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }
}
