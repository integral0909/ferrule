import { readFileSync } from 'node:fs';
import { decodeEventBatch, encodeEventBatch } from '@ferrule/buffer';
import { FerruleError, isLogEvent, type Event, type LogEvent, type ValueMap } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  resolveWorkerEntry,
  WorkerPool,
  DEFAULT_PORT,
  ERROR_PORT,
  Metrics,
  type Counter,
  type Histogram,
  type OutputPort,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import type { AbortCause, ResourceLimits, Type } from '@ferrule/script';
import { compileScriptSource } from './util/scriptCompile.js';
import { FIELD_KIND_NAMES, inputSchemaType } from './util/inputSchema.js';
import type {
  ScriptWorkerInit,
  ScriptWorkerOutcome,
  ScriptWorkerResponseMeta,
} from './worker/script-worker-protocol.js';

/**
 * `script` — runs a compiled Ferrule Script program over every log event. See
 * `packages/script/README.md` for the language; this transform is the pipeline-facing wrapper
 * that compiles the program once at build time (so a syntax or type error is reported during
 * `ferrule validate`/pipeline startup, with the same rendered code frames the language package
 * produces) and runs it once per event at process time.
 *
 * **Metric and span events pass through unchanged.** `@ferrule/script`'s compiler only supports
 * `LogEvent` (see the script README's "Execution model: logs only") — there is no supported way
 * to run a compiled program against a `MetricEvent`/`SpanEvent` today. Rather than reject a
 * mixed-kind pipeline outright, this transform forwards metric/span events untouched (counted by
 * `script_passthrough_events_total`, tagged `kind`), so `script` can still sit in a pipeline that
 * also carries metrics/spans past it to another transform or sink.
 *
 * **Outcomes.** Every log event's `program.run(...)` produces one of:
 *
 * - `continue` — `events[0]` (the same, possibly mutated, event object) is pushed on the default
 *   port; any events an `emit()` call added are pushed too, each carrying a *clone* of the
 *   original event's finalizers (see `packages/runtime/README.md`'s fan-out contract) so the
 *   upstream batch only acknowledges once every derived event finishes.
 * - `drop` — the event is discarded. By default this finishes its finalizers `delivered` (an
 *   intentional drop, per the package README's shared finalizer contract); set `reroute_dropped`
 *   to route it to the `dropped` port instead.
 * - `abort` — the event failed. `Outcome.cause` (a structured field, not a string match on
 *   `reason` — see `@ferrule/script`'s `AbortCause`) tells apart a deliberate `abort`/mismatch
 *   (`cause: 'abort'`, routed by `drop_on_abort`) from a resource-limit or genuine bug
 *   (`cause: 'limit'`/`'internal'`, routed by `drop_on_error`).
 *   Unless the applicable flag is `true` (in which case the event is finished `rejected` and
 *   counted under `component_discarded_events_total`), the event is routed to the `errors` port
 *   with the failure recorded under the event's own `ferrule.error` field:
 *   `ferrule.error.reason` (string), `ferrule.error.span.start`/`.end` (int, UTF-16 offsets into
 *   the script source), and `ferrule.error.transform` (this component's ID). The `errors` port is
 *   always declared; a component that never wires it simply has those events counted as
 *   discarded (the runtime finishes an unwired port's events `delivered` automatically — see
 *   `packages/runtime/README.md`'s transform output routing).
 *
 * **`workers: <n>`** runs the program across `n` `worker_threads` (`@ferrule/runtime`'s
 * `WorkerPool`) instead of in-thread: each batch's log events are split into up to `n`
 * contiguous chunks, run concurrently (`processAsync`, not `process` — see
 * `packages/runtime/README.md`'s "Asynchronous transforms"), and reattached to the original
 * events by position once every chunk comes back. See `packages/operators/README.md`'s "Worker
 * pool (CPU-heavy `script`)" for the full design, including what differs from the in-thread path
 * (`now()`'s clock, a per-chunk rather than per-event duration sample, and `errored` rather than
 * routed-to-`errors`/`drop_on_*` handling for a chunk whose worker crashed twice). `workers: 0`
 * (the default) is the original, unchanged in-thread behaviour.
 */

const DROPPED_PORT = 'dropped';

const limitsOptions = s.object({
  max_string_length: s
    .integer({ min: 1 })
    .optional()
    .describe('override for the string-length resource limit'),
  max_collection_size: s
    .integer({ min: 1 })
    .optional()
    .describe('override for the array/object size resource limit'),
  max_regex_input_length: s
    .integer({ min: 1 })
    .optional()
    .describe('override for the regex subject-length resource limit'),
  max_emitted_events: s
    .integer({ min: 1 })
    .optional()
    .describe('override for the maximum number of events emit() may add'),
});

export const scriptOptions = s
  .object({
    source: s.string({ minLength: 1 }).optional().describe('inline Ferrule Script source'),
    file: s
      .string({ minLength: 1 })
      .optional()
      .describe('path to a .fer file, read once at build time'),
    input_schema: s
      .record(s.enum(FIELD_KIND_NAMES))
      .optional()
      .describe(
        'declarative field -> type map (e.g. { status: int, message: string }) used to type ' +
          '.field paths; fields not listed stay `any`. See docs/language/design.md §3.',
      ),
    drop_on_abort: s
      .boolean()
      .default(false)
      .describe(
        'when a deliberate abort()/type-mismatch abort happens: finish the event `rejected` ' +
          'and count it (true), or route it to the `errors` port (false, the default)',
      ),
    drop_on_error: s
      .boolean()
      .default(false)
      .describe(
        'when a resource-limit or internal-error abort happens (Outcome.cause `limit`/`internal`, ' +
          'see @ferrule/script): finish the event `rejected` and count it (true), or ' +
          'route it to the `errors` port (false, the default)',
      ),
    reroute_dropped: s
      .boolean()
      .default(false)
      .describe('route drop()ped events to the `dropped` port instead of finishing them delivered'),
    limits: limitsOptions.default({}).describe('per-event resource limit overrides'),
    workers: s
      .integer({ min: 0 })
      .default(0)
      .describe(
        'run the program across N worker_threads, splitting each batch across them; 0 (the ' +
          'default) runs in-thread. See the "Worker pool" section of the operators README.',
      ),
  })
  .refine(
    (o) => (o.source === undefined) !== (o.file === undefined),
    'exactly one of `source` or `file` must be given',
  );

export type ScriptOptions = Infer<typeof scriptOptions>;

function readScriptFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new FerruleError(
      'E_SCRIPT_FILE',
      `could not read script file ${JSON.stringify(path)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveLimitOverrides(options: ScriptOptions['limits']): Partial<ResourceLimits> {
  const overrides: { -readonly [K in keyof ResourceLimits]?: number } = {};
  if (options.max_string_length !== undefined) {
    overrides.maxStringLength = options.max_string_length;
  }
  if (options.max_collection_size !== undefined) {
    overrides.maxCollectionSize = options.max_collection_size;
  }
  if (options.max_regex_input_length !== undefined) {
    overrides.maxRegexInputLength = options.max_regex_input_length;
  }
  if (options.max_emitted_events !== undefined) {
    overrides.maxEmittedEvents = options.max_emitted_events;
  }
  return overrides;
}

/** `cause: 'limit'`/`'internal'` are routed by `drop_on_error`; `cause: 'abort'` by `drop_on_abort`. */
function isInternalAbort(cause: AbortCause): boolean {
  return cause === 'limit' || cause === 'internal';
}

function attachAbortMetadata(
  log: LogEvent,
  transformId: string,
  reason: string,
  span: { start: number; end: number },
): void {
  log.set('ferrule.error.reason', reason);
  log.set('ferrule.error.span.start', BigInt(span.start));
  log.set('ferrule.error.span.end', BigInt(span.end));
  log.set('ferrule.error.transform', transformId);
}

export const scriptTransform = defineTransform<ScriptOptions>({
  kind: 'transform',
  type: 'script',
  description:
    'Runs a compiled Ferrule Script program over log events; metrics/spans pass through.',
  options: scriptOptions,
  accepts: ['log', 'metric', 'span'],
  outputs: (options): readonly OutputPort[] => {
    const ports: OutputPort[] = [
      { name: ERROR_PORT, description: 'events the script aborted (unless drop_on_abort/error)' },
    ];
    if (options.reroute_dropped) {
      ports.push({ name: DROPPED_PORT, description: 'events the script drop()ped' });
    }
    return ports;
  },
  examples: [
    {
      title: 'Normalise a status field and drop debug logs',
      config: {
        source: '.status = upcase(.status) ?? "unknown"\n' + 'if .level == "debug" { drop }\n',
      },
    },
  ],
  build: (options) => {
    const sourceText = options.source ?? readScriptFile(options.file!);
    const fileName = options.file ?? '<inline script>';
    const inputSchema = inputSchemaType(options.input_schema);
    const compileOpts: { inputSchema?: Type } = {};
    if (inputSchema !== undefined) compileOpts.inputSchema = inputSchema;
    const program = compileScriptSource(sourceText, fileName, compileOpts);
    const limits = resolveLimitOverrides(options.limits);

    let ctx!: TransformContext;
    let continueCounter!: Counter;
    let dropCounter!: Counter;
    let abortCounter!: Counter;
    let discardedAbortCounter!: Counter;
    let discardedErrorCounter!: Counter;
    let durationHistogram!: Histogram;
    let chunkFailureCounter!: Counter;

    // --- Outcome application: shared between the in-thread path (process) and the worker-pool
    // path (processAsync) below, so the finalizer/metric/port rules are defined exactly once.
    // `original` always carries the real finalizers (and, for the worker path, is a different
    // object than the one that actually ran the script — see `applyChunkResult`); `fields` is
    // whatever the run actually produced for it, which may be `original.fields` itself
    // (in-thread: the script mutates `original` directly, so this is a no-op) or freshly decoded
    // (worker path: `original`'s own fields are replaced with what came back over the wire).

    function applyContinue(
      original: LogEvent,
      fields: ValueMap,
      extras: readonly LogEvent[],
    ): (out: TransformOutput) => void {
      return (out: TransformOutput) => {
        continueCounter.increment();
        original.fields = fields;
        out.push(original, DEFAULT_PORT);
        for (const extraEvent of extras) {
          extraEvent.metadata.finalizers.merge(original.metadata.finalizers.clone());
          out.push(extraEvent, DEFAULT_PORT);
        }
      };
    }

    function applyDrop(original: LogEvent): (out: TransformOutput) => void {
      return (out: TransformOutput) => {
        dropCounter.increment();
        if (options.reroute_dropped) {
          out.push(original, DROPPED_PORT);
        } else {
          original.metadata.finalizers.finish('delivered');
        }
      };
    }

    function applyAbort(
      original: LogEvent,
      fields: ValueMap,
      reason: string,
      span: { start: number; end: number },
      cause: AbortCause,
    ): (out: TransformOutput) => void {
      return (out: TransformOutput) => {
        abortCounter.increment();
        original.fields = fields;
        const internal = isInternalAbort(cause);
        const shouldDrop = internal ? options.drop_on_error : options.drop_on_abort;
        if (shouldDrop) {
          (internal ? discardedErrorCounter : discardedAbortCounter).increment();
          original.metadata.finalizers.finish('rejected');
        } else {
          attachAbortMetadata(original, ctx.id, reason, span);
          out.push(original, ERROR_PORT);
        }
      };
    }

    // --- In-thread path (workers: 0, the default) -------------------------------------------

    function runInThread(log: LogEvent, out: TransformOutput): void {
      const startedAtMs = ctx.clock.monotonic();
      const outcome = program.run(log, { limits, clock: () => ctx.clock.now() });
      durationHistogram.record((ctx.clock.monotonic() - startedAtMs) / 1000);
      switch (outcome.kind) {
        case 'continue': {
          const [first, ...extra] = outcome.events;
          applyContinue(log, (first ?? log).fields, extra)(out);
          break;
        }
        case 'drop':
          applyDrop(log)(out);
          break;
        case 'abort':
          applyAbort(log, log.fields, outcome.reason, outcome.span, outcome.cause)(out);
          break;
      }
    }

    // --- Worker-pool path (workers: N > 0) ----------------------------------------------------

    let pool: WorkerPool<ScriptWorkerInit, undefined, ScriptWorkerResponseMeta> | undefined;
    if (options.workers > 0) {
      const url = resolveWorkerEntry(import.meta.url, 'worker/script-worker-entry.ts');
      const init: ScriptWorkerInit = {
        source: sourceText,
        fileName,
        inputSchema: options.input_schema,
        limits,
      };
      pool = new WorkerPool<ScriptWorkerInit, undefined, ScriptWorkerResponseMeta>({
        url,
        workerCount: options.workers,
        init,
      });
    }

    /** Runs one chunk through the pool. Never throws: a failed submission (crash-then-crash,
     *  the pool closing, or `ctx.signal` aborting while still queued) finishes the chunk's
     *  events `errored` itself and returns `undefined`, since by that point nothing is known
     *  about what, if anything, the chunk's events actually had done to them. */
    async function runChunk(
      chunk: readonly LogEvent[],
    ): Promise<{ meta: ScriptWorkerResponseMeta; payload: Uint8Array } | undefined> {
      try {
        return await pool!.submit(
          { meta: undefined, payload: encodeEventBatch(chunk) },
          ctx.signal,
        );
      } catch (error) {
        chunkFailureCounter.increment();
        ctx.logger.warn('script worker chunk failed; finishing its events errored', {
          error: error instanceof Error ? error.message : String(error),
          chunkSize: chunk.length,
        });
        for (const event of chunk) event.metadata.finalizers.finish('errored');
        return undefined;
      }
    }

    function applyChunkResult(
      chunk: readonly LogEvent[],
      result: { meta: ScriptWorkerResponseMeta; payload: Uint8Array },
      out: TransformOutput,
    ): void {
      const outputEvents = decodeEventBatch(result.payload) as LogEvent[];
      let cursor = 0;
      for (let i = 0; i < chunk.length; i++) {
        const original = chunk[i]!;
        const outcome: ScriptWorkerOutcome = result.meta.outcomes[i]!;
        switch (outcome.kind) {
          case 'continue': {
            const primary = outputEvents[cursor++]!;
            const extras: LogEvent[] = [];
            for (let k = 0; k < outcome.extraCount; k++) extras.push(outputEvents[cursor++]!);
            applyContinue(original, primary.fields, extras)(out);
            break;
          }
          case 'drop':
            applyDrop(original)(out);
            break;
          case 'abort': {
            const primary = outputEvents[cursor++]!;
            applyAbort(original, primary.fields, outcome.reason, outcome.span, outcome.cause)(out);
            break;
          }
        }
      }
    }

    /** Splits `logEvents` into up to `options.workers` contiguous chunks (never more chunks
     *  than events, so a small batch doesn't dispatch empty work to idle workers). */
    function chunkForWorkers(logEvents: readonly LogEvent[]): LogEvent[][] {
      const chunkCount = Math.min(options.workers, logEvents.length);
      const chunkSize = Math.ceil(logEvents.length / chunkCount);
      const chunks: LogEvent[][] = [];
      for (let i = 0; i < logEvents.length; i += chunkSize) {
        chunks.push(logEvents.slice(i, i + chunkSize));
      }
      return chunks;
    }

    const start = (context: TransformContext): void => {
      ctx = context;
      continueCounter = ctx.metrics.counter('script_events_total', { outcome: 'continue' });
      dropCounter = ctx.metrics.counter('script_events_total', { outcome: 'drop' });
      abortCounter = ctx.metrics.counter('script_events_total', { outcome: 'abort' });
      discardedAbortCounter = ctx.metrics.counter(Metrics.discardedEvents, {
        reason: 'script_abort',
      });
      discardedErrorCounter = ctx.metrics.counter(Metrics.discardedEvents, {
        reason: 'script_error',
      });
      durationHistogram = ctx.metrics.histogram('script_run_duration_seconds');
      chunkFailureCounter = ctx.metrics.counter('script_worker_chunk_failures_total');
    };

    function passthrough(event: Event, out: TransformOutput): void {
      ctx.metrics.counter('script_passthrough_events_total', { kind: event.kind }).increment();
      out.push(event, DEFAULT_PORT);
    }

    if (options.workers === 0) {
      return {
        start,
        process(events: Event[], out: TransformOutput) {
          for (const event of events) {
            if (!isLogEvent(event)) {
              passthrough(event, out);
              continue;
            }
            runInThread(event, out);
          }
        },
      };
    }

    return {
      start,
      async processAsync(events: Event[], out: TransformOutput) {
        const logEvents: LogEvent[] = [];
        for (const event of events) {
          if (!isLogEvent(event)) {
            passthrough(event, out);
            continue;
          }
          logEvents.push(event);
        }
        if (logEvents.length === 0) return;

        const chunks = chunkForWorkers(logEvents);
        const startedAtMs = ctx.clock.monotonic();
        const results = await Promise.all(chunks.map((chunk) => runChunk(chunk)));
        const elapsedSeconds = (ctx.clock.monotonic() - startedAtMs) / 1000;
        // One aggregate sample per event, since chunks ran concurrently: this is not a per-event
        // measurement the way the in-thread path's is, only a rough per-event share of the
        // batch's wall time — see packages/operators/README.md's "Worker pool" section.
        for (let i = 0; i < logEvents.length; i++) {
          durationHistogram.record(elapsedSeconds / logEvents.length);
        }

        for (let i = 0; i < chunks.length; i++) {
          const result = results[i];
          if (result === undefined) continue; // already finished errored in runChunk
          applyChunkResult(chunks[i]!, result, out);
        }
      },
      // `Transform.flush` is typed to return `void`, but `pipeline.ts` actually awaits whatever
      // it returns (`rc.mutex.run<T>(fn: () => T | Promise<T>)`) before considering the
      // transform stopped — the same way `tick`/`process` are allowed to be synchronous-looking
      // but secretly async elsewhere in this codebase. Closing the pool here, not in
      // `processAsync` itself, means it only happens once, when this transform instance's own
      // run loop ends (shutdown, or being retired by a reload) — see `component.ts`'s "Called
      // once when the transform stops" and `pipeline.ts`'s `runTransform`.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- verified above: pipeline.ts awaits this
      async flush() {
        await pool?.close();
      },
    };
  },
});
