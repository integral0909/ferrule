/**
 * A `SourceContext` test harness with a *controllable* output, unlike
 * `@ferrule/runtime`'s `createTestSourceContext` (whose `output.send` always resolves
 * immediately). Backpressure tests need `send` to hang until the test says otherwise.
 */
import type { Event } from '@ferrule/core';
import {
  DEFAULT_PORT,
  ManualClock,
  MetricsRegistry,
  createCapturingLogger,
  type CapturedLogRecord,
  type Logger,
  type SourceContext,
  type SourceOutput,
} from '@ferrule/runtime';

export interface SentBatch {
  readonly port: string;
  readonly events: Event[];
}

export interface ControllableSourceHarness {
  readonly ctx: SourceContext;
  readonly clock: ManualClock;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly logs: CapturedLogRecord[];
  readonly sent: SentBatch[];
  /** Makes every future `output.send` call hang until {@link releaseSends} is called. */
  blockSends(): void;
  /** Resolves every `output.send` call currently (or subsequently) blocked. */
  releaseSends(): void;
  abort(reason?: unknown): void;
}

export interface ControllableSourceContextOptions {
  readonly id?: string;
  readonly type?: string;
  readonly dataDir?: string;
  readonly acknowledgements?: boolean;
}

export function createControllableSourceContext(
  options: ControllableSourceContextOptions = {},
): ControllableSourceHarness {
  const clock = new ManualClock();
  const metrics = new MetricsRegistry({ clock });
  const { logger, records } = createCapturingLogger();
  const abortController = new AbortController();
  const sent: SentBatch[] = [];

  let gate: { promise: Promise<void>; resolve: () => void } | undefined;

  function isEventArray(events: Event | readonly Event[]): events is readonly Event[] {
    return Array.isArray(events);
  }

  const output: SourceOutput = {
    send: async (events, port = DEFAULT_PORT) => {
      const list = isEventArray(events) ? [...events] : [events];
      sent.push({ port, events: list });
      if (gate !== undefined) await gate.promise;
    },
  };

  const ctx: SourceContext = {
    id: options.id ?? 'test-source',
    type: options.type ?? 'test',
    kind: 'source',
    logger,
    metrics,
    clock,
    signal: abortController.signal,
    dataDir: options.dataDir,
    acknowledgements: options.acknowledgements ?? true,
    output,
  };

  return {
    ctx,
    clock,
    metrics,
    logger,
    logs: records,
    sent,
    blockSends: () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { promise, resolve };
    },
    releaseSends: () => {
      gate?.resolve();
      gate = undefined;
    },
    abort: (reason?: unknown) => abortController.abort(reason),
  };
}

/** Polls `condition` with no real delay between checks, for up to `timeoutMs` of wall-clock
 * time. Deterministic enough for waiting on another async task to reach a synchronization point
 * (e.g. "the request handler has called `output.send`") without a fixed sleep. */
export async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('waitUntil: condition never became true');
}
