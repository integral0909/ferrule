import { readFileSync } from 'node:fs';
import {
  FerruleError,
  isLogEvent,
  isMetricEvent,
  type Event,
  type LogEvent,
  type MetricEvent,
} from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  ERROR_PORT,
  Metrics,
  type Counter,
  type Histogram,
  type OutputPort,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import type {
  AbortCause,
  AnyCompiledProgram,
  CompiledProgram,
  Outcome,
  ResourceLimits,
  RunOptions,
  ScriptTarget,
  Type,
} from '@ferrule/script';
import { compileScriptSource } from './util/scriptCompile.js';
import { FIELD_KIND_NAMES, inputSchemaType } from './util/inputSchema.js';

/**
 * `script` — runs a compiled Ferrule Script program over every event of one kind. See
 * `packages/script/README.md` for the language; this transform is the pipeline-facing wrapper
 * that compiles the program once at build time (so a syntax or type error is reported during
 * `ferrule validate`/pipeline startup, with the same rendered code frames the language package
 * produces) and runs it once per event at process time.
 *
 * **`event_kind` picks which kind the program transforms** — `log` (the default) or `metric`.
 * A program is compiled against one event shape: a log event's fields are free-form and type as
 * `any` (or as `input_schema` declares), while a metric has a fixed, closed shape
 * (`.name`, `.tags.host`, `.value`, ... — see the script README's "Execution model"), so one
 * compiled program cannot serve both. Spans are not supported by either.
 *
 * **Events of the other kind pass through unchanged**, counted by
 * `script_passthrough_events_total` (tagged `kind`), so a `script` can sit in a pipeline that
 * also carries other kinds past it to another transform or sink, rather than rejecting a
 * mixed-kind pipeline outright.
 *
 * **Outcomes.** Every transformed event's `program.run(...)` produces one of:
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
    event_kind: s
      .enum(['log', 'metric'] as const)
      .default('log')
      .describe(
        'which event kind the program transforms; events of the other kind pass through ' +
          'unchanged. A metric script sees the fixed metric shape (.name, .tags, .value, ...)',
      ),
    input_schema: s
      .record(s.enum(FIELD_KIND_NAMES))
      .optional()
      .describe(
        'declarative field -> type map (e.g. { status: int, message: string }) used to type ' +
          '.field paths; fields not listed stay `any`. See docs/language/design.md §3. ' +
          "Log events only: a metric's shape is fixed and already fully typed.",
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
  })
  .refine(
    (o) => (o.source === undefined) !== (o.file === undefined),
    'exactly one of `source` or `file` must be given',
  )
  .refine(
    (o) => o.event_kind !== 'metric' || o.input_schema === undefined,
    "`input_schema` describes a log event's fields and cannot be used with `event_kind: metric`; a metric's shape is fixed and already typed",
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

/**
 * Records why the script aborted, for the `errors` port. Only log events carry it: a metric has
 * no free-form fields to put it in, and inventing tags for it would change the series' identity
 * and blow up its cardinality, so a metric's failure is written to the component log instead and
 * the event is routed on unannotated (see the `abort` case in `process`).
 */
function attachAbortMetadata(
  event: LogEvent,
  transformId: string,
  reason: string,
  span: { start: number; end: number },
): void {
  event.set('ferrule.error.reason', reason);
  event.set('ferrule.error.span.start', BigInt(span.start));
  event.set('ferrule.error.span.end', BigInt(span.end));
  event.set('ferrule.error.transform', transformId);
}

export const scriptTransform = defineTransform<ScriptOptions>({
  kind: 'transform',
  type: 'script',
  description:
    'Runs a compiled Ferrule Script program over log or metric events; other kinds pass through.',
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
    {
      title: 'Rename a metric and drop a high-cardinality tag',
      config: {
        event_kind: 'metric',
        source:
          '.name = replace(.name, "legacy_", "") ?? .name\n' +
          'del(.tags.request_id)\n' +
          'if .tags.env == "test" { drop }\n',
      },
    },
  ],
  build: (options) => {
    const sourceText = options.source ?? readScriptFile(options.file!);
    const fileName = options.file ?? '<inline script>';
    const target: ScriptTarget = options.event_kind;
    const inputSchema = inputSchemaType(options.input_schema);
    const compileOpts: { inputSchema?: Type; target?: ScriptTarget } = { target };
    if (inputSchema !== undefined) compileOpts.inputSchema = inputSchema;
    const program: AnyCompiledProgram = compileScriptSource(sourceText, fileName, compileOpts);
    /** True for the one event kind this program transforms; everything else passes through. */
    const transforms = target === 'metric' ? isMetricEvent : isLogEvent;
    /**
     * `program`'s `run` is typed for one event kind and `transforms` guarantees it gets that
     * kind, but TypeScript cannot tie the two together through the `AnyCompiledProgram` union.
     * Binding the right one here — once, at build time — keeps the cast out of the hot loop.
     */
    const runProgram: (event: Event, runOptions: RunOptions) => Outcome<LogEvent | MetricEvent> =
      target === 'metric'
        ? (event, runOptions) =>
            (program as CompiledProgram<MetricEvent>).run(event as MetricEvent, runOptions)
        : (event, runOptions) =>
            (program as CompiledProgram<LogEvent>).run(event as LogEvent, runOptions);
    const limits = resolveLimitOverrides(options.limits);

    let ctx!: TransformContext;
    let continueCounter!: Counter;
    let dropCounter!: Counter;
    let abortCounter!: Counter;
    let discardedAbortCounter!: Counter;
    let discardedErrorCounter!: Counter;
    let durationHistogram!: Histogram;

    return {
      start(context) {
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
      },
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          if (!transforms(event)) {
            ctx.metrics
              .counter('script_passthrough_events_total', { kind: event.kind })
              .increment();
            out.push(event, DEFAULT_PORT);
            continue;
          }
          const subject = event;
          const startedAtMs = ctx.clock.monotonic();
          const outcome = runProgram(subject, { limits, clock: () => ctx.clock.now() });
          durationHistogram.record((ctx.clock.monotonic() - startedAtMs) / 1000);

          switch (outcome.kind) {
            case 'continue': {
              continueCounter.increment();
              const [first, ...extra] = outcome.events;
              out.push(first ?? subject, DEFAULT_PORT);
              for (const extraEvent of extra) {
                extraEvent.metadata.finalizers.merge(subject.metadata.finalizers.clone());
                out.push(extraEvent, DEFAULT_PORT);
              }
              break;
            }
            case 'drop': {
              dropCounter.increment();
              if (options.reroute_dropped) {
                out.push(subject, DROPPED_PORT);
              } else {
                subject.metadata.finalizers.finish('delivered');
              }
              break;
            }
            case 'abort': {
              abortCounter.increment();
              const internal = isInternalAbort(outcome.cause);
              const shouldDrop = internal ? options.drop_on_error : options.drop_on_abort;
              if (shouldDrop) {
                (internal ? discardedErrorCounter : discardedAbortCounter).increment();
                subject.metadata.finalizers.finish('rejected');
              } else {
                if (isLogEvent(subject)) {
                  attachAbortMetadata(subject, ctx.id, outcome.reason, outcome.span);
                } else {
                  // A metric has nowhere to carry the reason (see `attachAbortMetadata`), so it
                  // goes to the component log instead — rate-limited by the runtime's logger.
                  ctx.logger.warn('script aborted a metric event', {
                    reason: outcome.reason,
                    span_start: outcome.span.start,
                    span_end: outcome.span.end,
                    metric: subject.series.name,
                  });
                }
                out.push(subject, ERROR_PORT);
              }
              break;
            }
          }
        }
      },
    };
  },
});
