import { readFileSync } from 'node:fs';
import {
  FerruleError,
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  type Event,
  type LogEvent,
  type MetricEvent,
  type SpanEvent,
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
import {
  applyViewToMetric,
  applyViewToSpan,
  metricEventSchema,
  metricEventToView,
  metricReadonlyPaths,
  outcomeForError,
  spanEventSchema,
  spanEventToView,
  spanReadonlyPaths,
  type AbortCause,
  type Outcome,
  type ResourceLimits,
  type Span,
  type Type,
} from '@ferrule/script';
import { compileScriptSource } from './util/scriptCompile.js';
import { FIELD_KIND_NAMES, inputSchemaType } from './util/inputSchema.js';

const EVENT_KINDS = ['log', 'metric', 'span'] as const;

/**
 * `script` — runs a compiled Ferrule Script program over every event of one kind, chosen by
 * `event_kind` (default `log`). See `packages/script/README.md` for the language; this transform
 * is the pipeline-facing wrapper that compiles the program once at build time (so a syntax or type
 * error is reported during `ferrule validate`/pipeline startup, with the same rendered code frames
 * the language package produces) and runs it once per event at process time.
 *
 * **One instance handles one event kind; the other kinds pass through**, counted by
 * `script_passthrough_events_total` (tagged `kind`). `event_kind: log` (the default) checks and
 * runs the program against log events directly; `event_kind: metric` checks it against the metric
 * view instead (`@ferrule/script`'s `metricEventSchema`/`metric/view.ts` — see
 * `docs/language/design.md`'s "Metric events"); `event_kind: span` checks it against the span view
 * (`spanEventSchema`/`span/view.ts` — see design.md's "Span events"). A single instance never runs
 * the same program against two kinds — their field shapes have nothing in common, so a script
 * written for one would almost never also make sense for another; put a `split_by_kind` ahead of
 * several `script` instances if a pipeline genuinely needs more than one.
 *
 * **A metric or span abort's error-port event is that event's log-shaped view, not the
 * `MetricEvent`/`SpanEvent` itself** — neither has a field bag of its own to attach
 * `ferrule.error.*` to, so there is nowhere else to put it; the view carries the event's fields
 * flat (`.name`, `.tags`, `.value`, ... for a metric; `.name`, `.kind`, `.attributes`, ... for a
 * span — see `@ferrule/script`'s `metric/schema.ts`/`span/schema.ts` for the exact shapes, which
 * are their own script-facing conventions, distinct from `metric_to_log`'s nested log
 * representation), plus whatever the script mutated before failing, and shares the original
 * event's finalizers so acknowledgement still behaves exactly as if the event itself had been
 * pushed.
 *
 * **Outcomes.** Every processed event's `program.run(...)` produces one of:
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
    event_kind: s
      .enum(EVENT_KINDS)
      .default('log')
      .describe(
        'which event kind the program runs on; the other kinds then pass through unchanged. ' +
          "`metric`/`span` check the program against that kind's view instead of `input_schema` " +
          '(see docs/language/design.md §"Metric events"/"Span events") — `input_schema` has no ' +
          'effect unless `event_kind` is `log`, since metric/span fields are typed automatically.',
      ),
    limits: limitsOptions.default({}).describe('per-event resource limit overrides'),
  })
  .refine(
    (o) => (o.source === undefined) !== (o.file === undefined),
    'exactly one of `source` or `file` must be given',
  )
  .refine(
    (o) => o.event_kind === 'log' || o.input_schema === undefined,
    '`input_schema` types log fields; it has no effect unless `event_kind` is `log`',
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
    'Runs a compiled Ferrule Script program over log events, or (with `metrics`) metric events.',
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
      title: 'Add a derived tag to every metric',
      config: {
        event_kind: 'metric',
        source: '.tags.service = "checkout"\n',
      },
    },
    {
      title: 'Drop health-check spans by attribute',
      config: {
        event_kind: 'span',
        source: 'if .attributes.http_route == "/healthz" { drop }\n',
      },
    },
  ],
  build: (options) => {
    const sourceText = options.source ?? readScriptFile(options.file!);
    const fileName = options.file ?? '<inline script>';
    const compileOpts: {
      inputSchema?: Type;
      validateWrites?: boolean;
      readonlyPaths?: ReadonlyMap<string, string>;
    } = {};
    switch (options.event_kind) {
      case 'metric':
        compileOpts.inputSchema = metricEventSchema();
        compileOpts.validateWrites = true;
        compileOpts.readonlyPaths = metricReadonlyPaths();
        break;
      case 'span':
        compileOpts.inputSchema = spanEventSchema();
        compileOpts.validateWrites = true;
        compileOpts.readonlyPaths = spanReadonlyPaths();
        break;
      case 'log': {
        const inputSchema = inputSchemaType(options.input_schema);
        if (inputSchema !== undefined) compileOpts.inputSchema = inputSchema;
        break;
      }
    }
    const program = compileScriptSource(sourceText, fileName, compileOpts);
    const limits = resolveLimitOverrides(options.limits);
    const rootSpan: Span = program.checkResult.program.span;

    let ctx!: TransformContext;
    let continueCounter!: Counter;
    let dropCounter!: Counter;
    let abortCounter!: Counter;
    let discardedAbortCounter!: Counter;
    let discardedErrorCounter!: Counter;
    let durationHistogram!: Histogram;

    /**
     * Shared by the log/metric/span paths below: `errorLog` is a `LogEvent` either way — for a
     * metric or span, that's its synthetic view, since neither has a field bag of its own to
     * attach `ferrule.error.*` to (see the module doc's "error-port event" note). `finishRejected`
     * finishes the *original* event's finalizers, which for a metric/span means the
     * `MetricEvent`/`SpanEvent` itself, not the view, even though they currently share the same
     * `Finalizers` instance.
     */
    function handleAbort(
      aborted: Extract<Outcome, { kind: 'abort' }>,
      errorLog: LogEvent,
      out: TransformOutput,
      finishRejected: () => void,
    ): void {
      abortCounter.increment();
      const internal = isInternalAbort(aborted.cause);
      const shouldDrop = internal ? options.drop_on_error : options.drop_on_abort;
      if (shouldDrop) {
        (internal ? discardedErrorCounter : discardedAbortCounter).increment();
        finishRejected();
      } else {
        attachAbortMetadata(errorLog, ctx.id, aborted.reason, aborted.span);
        out.push(errorLog, ERROR_PORT);
      }
    }

    function runLog(log: LogEvent, out: TransformOutput): void {
      const startedAtMs = ctx.clock.monotonic();
      const outcome = program.run(log, { limits, clock: () => ctx.clock.now() });
      durationHistogram.record((ctx.clock.monotonic() - startedAtMs) / 1000);

      switch (outcome.kind) {
        case 'continue': {
          continueCounter.increment();
          const [first, ...extra] = outcome.events;
          out.push(first ?? log, DEFAULT_PORT);
          for (const extraEvent of extra) {
            extraEvent.metadata.finalizers.merge(log.metadata.finalizers.clone());
            out.push(extraEvent, DEFAULT_PORT);
          }
          return;
        }
        case 'drop': {
          dropCounter.increment();
          if (options.reroute_dropped) {
            out.push(log, DROPPED_PORT);
          } else {
            log.metadata.finalizers.finish('delivered');
          }
          return;
        }
        case 'abort':
          handleAbort(outcome, log, out, () => log.metadata.finalizers.finish('rejected'));
          return;
      }
    }

    /**
     * Runs the program against `metric`'s view (`metricEventToView`). On `continue`,
     * `applyViewToMetric` both validates and writes the result back into `metric` itself — a
     * failure there (invalid tags, a deleted required field, ...) is routed exactly like a
     * mid-run `abort`, since from the pipeline's perspective both mean "the script produced an
     * event this transform cannot forward as-is."
     */
    function runMetric(metric: MetricEvent, out: TransformOutput): void {
      const view = metricEventToView(metric);
      const startedAtMs = ctx.clock.monotonic();
      const outcome = program.run(view, { limits, clock: () => ctx.clock.now() });
      durationHistogram.record((ctx.clock.monotonic() - startedAtMs) / 1000);

      switch (outcome.kind) {
        case 'continue': {
          try {
            applyViewToMetric(metric, view, rootSpan);
          } catch (error) {
            // `applyViewToMetric` only ever throws a `ScriptSignal`, which `outcomeForError`
            // always turns into an `abort` outcome — the `if` just lets TypeScript see that.
            const asOutcome = outcomeForError(error, rootSpan);
            if (asOutcome.kind === 'abort') {
              handleAbort(asOutcome, view, out, () =>
                metric.metadata.finalizers.finish('rejected'),
              );
            }
            return;
          }
          continueCounter.increment();
          out.push(metric, DEFAULT_PORT);
          const [, ...extra] = outcome.events;
          for (const extraEvent of extra) {
            extraEvent.metadata.finalizers.merge(metric.metadata.finalizers.clone());
            out.push(extraEvent, DEFAULT_PORT);
          }
          return;
        }
        case 'drop': {
          dropCounter.increment();
          if (options.reroute_dropped) {
            out.push(metric, DROPPED_PORT);
          } else {
            metric.metadata.finalizers.finish('delivered');
          }
          return;
        }
        case 'abort':
          handleAbort(outcome, view, out, () => metric.metadata.finalizers.finish('rejected'));
          return;
      }
    }

    /**
     * Runs the program against `span`'s view (`spanEventToView`). On `continue`,
     * `applyViewToSpan` both validates and writes the result back into `span` itself — a failure
     * there (an invalid `.kind`/`.status.code`, a deleted required field, ...) is routed exactly
     * like a mid-run `abort`, same as `runMetric`.
     */
    function runSpan(spanEvent: SpanEvent, out: TransformOutput): void {
      const view = spanEventToView(spanEvent);
      const startedAtMs = ctx.clock.monotonic();
      const outcome = program.run(view, { limits, clock: () => ctx.clock.now() });
      durationHistogram.record((ctx.clock.monotonic() - startedAtMs) / 1000);

      switch (outcome.kind) {
        case 'continue': {
          try {
            applyViewToSpan(spanEvent, view, rootSpan);
          } catch (error) {
            // `applyViewToSpan` only ever throws a `ScriptSignal`, which `outcomeForError` always
            // turns into an `abort` outcome — the `if` just lets TypeScript see that.
            const asOutcome = outcomeForError(error, rootSpan);
            if (asOutcome.kind === 'abort') {
              handleAbort(asOutcome, view, out, () =>
                spanEvent.metadata.finalizers.finish('rejected'),
              );
            }
            return;
          }
          continueCounter.increment();
          out.push(spanEvent, DEFAULT_PORT);
          const [, ...extra] = outcome.events;
          for (const extraEvent of extra) {
            extraEvent.metadata.finalizers.merge(spanEvent.metadata.finalizers.clone());
            out.push(extraEvent, DEFAULT_PORT);
          }
          return;
        }
        case 'drop': {
          dropCounter.increment();
          if (options.reroute_dropped) {
            out.push(spanEvent, DROPPED_PORT);
          } else {
            spanEvent.metadata.finalizers.finish('delivered');
          }
          return;
        }
        case 'abort':
          handleAbort(outcome, view, out, () => spanEvent.metadata.finalizers.finish('rejected'));
          return;
      }
    }

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
          switch (options.event_kind) {
            case 'log':
              if (isLogEvent(event)) {
                runLog(event, out);
                continue;
              }
              break;
            case 'metric':
              if (isMetricEvent(event)) {
                runMetric(event, out);
                continue;
              }
              break;
            case 'span':
              if (isSpanEvent(event)) {
                runSpan(event, out);
                continue;
              }
              break;
          }
          ctx.metrics.counter('script_passthrough_events_total', { kind: event.kind }).increment();
          out.push(event, DEFAULT_PORT);
        }
      },
    };
  },
});
