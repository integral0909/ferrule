import { BatchNotifier, type DeliveryStatus, type Event } from '@ferrule/core';
import {
  createTestSinkContext,
  createTestSourceContext,
  createTestTransformContext,
  validateTransformContract,
  type CapturedLogRecord,
  type PushedEvent,
  type SentBatch,
  type SinkDefinition,
  type SourceDefinition,
  type TestContextOptions,
  type TestSourceHarness,
  type TransformDefinition,
} from '@ferrule/runtime';

/**
 * Component harnesses for plugin authors: thin wrappers over `@ferrule/runtime`'s own
 * `createTest*Context` helpers that additionally validate options through the definition's own
 * schema (exactly as a real pipeline would via `buildTopology`), and add finalizer-leak detection
 * where it can be checked without an unbounded wait.
 */

/** Waits for `promise`, or throws a leak error after `timeoutMs` if it never settles. */
function withLeakTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `finalizer leak: ${what} did not finish within ${timeoutMs}ms (an event's finalizer ` +
            'was never finished)',
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// -------------------------------------------------------------------------------------------
// testSource
// -------------------------------------------------------------------------------------------

export interface TestSourceResult {
  /** Every batch sent via `ctx.output.send`, in order. */
  readonly sent: readonly SentBatch[];
  readonly logs: readonly CapturedLogRecord[];
}

/**
 * Builds and runs `definition` against validated `rawOptions`, then hands `driver` the running
 * harness (`ctx`, `clock`, `abort()`, `sent`) to drive the source — advance the clock, wait for
 * expected sends, then call `harness.abort()` to end `run()`. Resolves once `run()` returns.
 */
export async function testSource<Options>(
  definition: SourceDefinition<Options>,
  rawOptions: unknown,
  driver: (harness: TestSourceHarness) => Promise<void> | void,
  harnessOptions: TestContextOptions = {},
): Promise<TestSourceResult> {
  const options = definition.options.parse(rawOptions);
  const harness = createTestSourceContext(harnessOptions);
  const source = await definition.build(options, {
    id: harness.ctx.id,
    logger: harness.ctx.logger,
    dataDir: harness.ctx.dataDir,
    inputs: [],
  });
  const runPromise = source.run(harness.ctx);
  await driver(harness);
  await runPromise;
  return { sent: harness.sent, logs: harness.logs };
}

// -------------------------------------------------------------------------------------------
// testTransform
// -------------------------------------------------------------------------------------------

export interface TestTransformResult {
  /** Every event pushed via `out.push`, in order, ports as declared. */
  readonly pushed: readonly PushedEvent[];
  readonly logs: readonly CapturedLogRecord[];
  /**
   * The combined delivery status of the input batch: `delivered` unless a pushed event's own
   * finish status (finished `delivered` on the caller's behalf, see below) or a dropped/rejected
   * event made it worse.
   */
  readonly status: DeliveryStatus;
}

export interface TestTransformOptions {
  readonly harness?: TestContextOptions;
  /** Calls `transform.flush?.(out)` after `process()`. Default `true`. */
  readonly flush?: boolean;
  /**
   * Status finished on every event the transform pushes onward, simulating "delivered
   * downstream" so the returned `status` is deterministic without a real sink (default
   * `'delivered'`). Pass `'none'` to leave pushed events unfinished — for a test that wants to
   * finish them itself and inspect `pushed` first; `status` is then always `'delivered'` and
   * reflects only the events the transform itself finished.
   */
  readonly finishPushed?: DeliveryStatus | 'none';
}

/**
 * Builds `definition` from validated `rawOptions`, runs `events` (mutated/consumed exactly as a
 * real pipeline would call `process`/`processAsync`/`flush`), and checks for a **finalizer
 * leak**: an event neither pushed onward (ownership transferred to whatever the test does with
 * `pushed`) nor finished by the transform itself is a bug, per `packages/runtime/README.md`'s
 * "every event's finalizers must be finished" contract, and fails loudly here instead of silently
 * hanging a batch's acknowledgement forever.
 *
 * Validates the same process/processAsync contract a real pipeline validates at build time (see
 * `validateTransformContract`), awaits `processAsync` when that is what the transform implements,
 * and applies the same finalizer-leak timeout used for `testSink`'s `run()` in case it never
 * resolves.
 */
export async function testTransform<Options>(
  definition: TransformDefinition<Options>,
  rawOptions: unknown,
  events: readonly Event[],
  testOptions: TestTransformOptions = {},
): Promise<TestTransformResult> {
  const options = definition.options.parse(rawOptions);
  const harness = createTestTransformContext(testOptions.harness ?? {});
  const transform = await definition.build(options, {
    id: harness.ctx.id,
    logger: harness.ctx.logger,
    dataDir: harness.ctx.dataDir,
    inputs: [],
  });
  validateTransformContract(transform, harness.ctx.id);
  transform.start?.(harness.ctx);

  const batch = new BatchNotifier();
  for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();

  if (transform.processAsync !== undefined) {
    await withLeakTimeout(
      transform.processAsync([...events], harness.out),
      5000,
      'transform processAsync()',
    );
  } else {
    transform.process!([...events], harness.out);
  }
  if (testOptions.flush !== false) transform.flush?.(harness.out);

  const pushedSet = new Set(harness.pushed.map((p) => p.event));
  const leaked: number[] = [];
  events.forEach((event, i) => {
    if (pushedSet.has(event)) return;
    if (!event.metadata.finalizers.isEmpty) leaked.push(i);
  });
  if (leaked.length > 0) {
    throw new Error(
      `finalizer leak: input event(s) at index ${leaked.join(', ')} were neither pushed onward ` +
        'nor had their finalizer finished by the transform',
    );
  }

  const finishStatus = testOptions.finishPushed ?? 'delivered';
  if (finishStatus !== 'none') {
    for (const { event } of harness.pushed) event.metadata.finalizers.finish(finishStatus);
    return {
      pushed: harness.pushed,
      logs: harness.logs,
      status: await withLeakTimeout(batch.completion, 2000, 'transform batch'),
    };
  }

  return { pushed: harness.pushed, logs: harness.logs, status: 'delivered' };
}

/** Throws unless `pushed`'s ports, in order, equal `expectedPorts`. */
export function assertPortOrder(
  pushed: readonly PushedEvent[],
  expectedPorts: readonly string[],
): void {
  const actual = pushed.map((p) => p.port);
  const matches =
    actual.length === expectedPorts.length && actual.every((p, i) => p === expectedPorts[i]);
  if (!matches) {
    throw new Error(
      `push order mismatch: expected ports [${expectedPorts.join(', ')}], got [${actual.join(', ')}]`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// testSink
// -------------------------------------------------------------------------------------------

export interface TestSinkResult {
  readonly logs: readonly CapturedLogRecord[];
  /** The combined delivery status of every event fed in. */
  readonly status: DeliveryStatus;
}

/**
 * Builds `definition` from validated `rawOptions`, feeds `events` to the sink, closes its input,
 * and awaits `run()` plus every event's finalizer finishing — with a finalizer-leak timeout, since
 * a sink that returns from `run()` without finishing an event would otherwise hang this call
 * forever (see `packages/runtime/README.md`: "every event must have its finalizers finished").
 */
export async function testSink<Options>(
  definition: SinkDefinition<Options>,
  rawOptions: unknown,
  events: readonly Event[],
  harnessOptions: TestContextOptions = {},
): Promise<TestSinkResult> {
  const options = definition.options.parse(rawOptions);
  const harness = createTestSinkContext(harnessOptions);
  const sink = await definition.build(options, {
    id: harness.ctx.id,
    logger: harness.ctx.logger,
    dataDir: harness.ctx.dataDir,
    inputs: [],
  });

  const batch = new BatchNotifier();
  for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();

  const runPromise = sink.run(harness.ctx);
  await harness.feed(events);
  harness.close();
  await withLeakTimeout(runPromise, 5000, 'sink run()');
  const status = await withLeakTimeout(batch.completion, 2000, 'sink event finalizers');

  return { logs: harness.logs, status };
}

export type {
  CapturedLogRecord,
  PushedEvent,
  SentBatch,
  TestContextOptions,
  TestSinkHarness,
  TestSourceHarness,
  TestTransformHarness,
} from '@ferrule/runtime';
