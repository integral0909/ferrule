import { isLogEvent, isSpanEvent, type Event } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  Metrics,
  type Counter,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import { spanEventSchema, spanEventToView, type CompiledProgram, type Type } from '@ferrule/script';
import { compileConditionSource } from './util/scriptCompile.js';
import { FIELD_KIND_NAMES, inputSchemaType } from './util/inputSchema.js';

const EVENT_KINDS = ['log', 'span'] as const;

/**
 * `filter` — keeps events of one kind (`event_kind`, default `log`) for which a Ferrule Script
 * boolean expression is true; the other kind passes through unchanged, counted by
 * `filter_passthrough_events_total` (tagged `kind`).
 *
 * **Compilation approach.** `condition` is a single Ferrule Script *expression*, not a full
 * program with statements — `@ferrule/script` doesn't expose a "value of the last expression"
 * form, so this compiles a tiny synthetic program that uses the language's own control flow
 * instead of writing a scratch field into the event and reading it back:
 *
 * ```
 * if !((<condition>) ?? <on_error fallback>) { drop }
 * ```
 *
 * `?? <fallback>` only has to run when `condition` is a fallible (`bool!`) expression — the
 * checker only warns, never errors, when `??` is applied to an already-non-fallible operand (see
 * `packages/script/src/check/checker.ts`'s `checkCoalesce`), so this wrapper compiles for both
 * fallible and non-fallible conditions unchanged. The compiled program's `Outcome` then *is* the
 * filter decision: `continue` keeps the event (pushed with its original finalizers intact, plus
 * any `emit()`-added events, exactly like `script`), `drop` discards it (finished `delivered`,
 * the ordinary "intentionally dropped" status).
 *
 * A **`Failure`** (a fallible sub-expression, e.g. `to_int(.x) > 5` when `.x` isn't numeric) is
 * caught by the `?? fallback` above and becomes an ordinary `true`/`false` — indistinguishable
 * from a "real" `true`/`false`, which is the same behaviour any Ferrule Script program gets from
 * `??`. An **`abort`** (an explicit `abort`, or an `any`-typed operand that turns out not to be a
 * `bool`/comparable kind at runtime — see the script package README's "Runtime: `any` and
 * operators") is *not* interceptable by `??` (design.md: termination is a single, uncatchable
 * signal), so it is handled here instead, by `on_error`: `keep` pushes the event through as if it
 * had matched; `drop` (the default) finishes it `rejected` (this is "bad data", the same
 * permanent-failure semantics `remap_fields`'s `on_error: drop` uses) and counts it under
 * `component_discarded_events_total` (`reason: condition_aborted`).
 *
 * `condition` is compiled inside a synthetic wrapper source (`if !((<condition>) ?? <fallback>)
 * { drop }`), but a compile error's code frame is rendered against `condition` itself — see
 * `compileConditionSource` in `./util/scriptCompile.js` — so the caret lands on the right token
 * in the user's own expression, not somewhere inside the wrapper around it.
 *
 * **`event_kind: span`** compiles `condition` against the span view instead
 * (`@ferrule/script`'s `spanEventSchema`/`span/view.ts` — see `docs/language/design.md`'s "Span
 * events"); `input_schema` has no effect in that case, since span fields are typed automatically.
 * A condition can only *read* the view (the grammar has no way to put an assignment statement
 * inside an expression), so there is nothing to write back — the original `SpanEvent` is what
 * gets pushed or dropped, never the view.
 */

export const filterOptions = s.object({
  condition: s.string({ minLength: 1 }).describe('a Ferrule Script boolean expression'),
  on_error: s
    .enum(['keep', 'drop'] as const)
    .default('drop')
    .describe(
      'what to do when the condition aborts (an explicit abort() or an any-typed runtime ' +
        'mismatch, not a handled Failure): keep the event as if it matched, or drop it (default)',
    ),
  input_schema: s
    .record(s.enum(FIELD_KIND_NAMES))
    .optional()
    .describe('declarative field -> type map used to type .field paths in the condition'),
  event_kind: s
    .enum(EVENT_KINDS)
    .default('log')
    .describe(
      'which event kind the condition runs against; the other kind then passes through ' +
        'unchanged. `span` checks the condition against the span view (see ' +
        'docs/language/design.md §"Span events") instead of `input_schema`, which has no effect ' +
        'unless `event_kind` is `log`.',
    ),
});

export type FilterOptions = Infer<typeof filterOptions>;

export const filterTransform = defineTransform<FilterOptions>({
  kind: 'transform',
  type: 'filter',
  description: 'Keeps events of one kind for which a Ferrule Script boolean expression is true.',
  options: filterOptions,
  accepts: ['log', 'span'],
  examples: [
    { title: 'Keep only 2xx/3xx responses', config: { condition: '.status < 400' } },
    {
      title: 'Drop health-check spans by attribute',
      config: { event_kind: 'span', condition: '.attributes.http_route != "/healthz"' },
    },
  ],
  build: (options) => {
    const compileOpts: { inputSchema?: Type } = {};
    if (options.event_kind === 'span') {
      compileOpts.inputSchema = spanEventSchema();
    } else {
      const inputSchema = inputSchemaType(options.input_schema);
      if (inputSchema !== undefined) compileOpts.inputSchema = inputSchema;
    }
    const program = compileConditionSource(
      options.condition,
      options.on_error === 'keep',
      '<filter condition>',
      compileOpts,
    );

    let ctx!: TransformContext;
    let keptCounter!: Counter;
    let droppedCounter!: Counter;
    let abortedCounter!: Counter;
    let discardedCounter!: Counter;

    /**
     * Runs the compiled condition against `ran` (the real event for `event_kind: log`, or its
     * read-only view for `event_kind: span`) and applies the decision to `original` — the two
     * differ only for spans, where `ran` is a throwaway `spanEventToView` copy but `original` is
     * the real `SpanEvent` that must be pushed/dropped/finished.
     */
    function decide(
      program: CompiledProgram,
      ran: Parameters<CompiledProgram['run']>[0],
      original: Event,
      out: TransformOutput,
    ): void {
      const outcome = program.run(ran, { clock: () => ctx.clock.now() });
      switch (outcome.kind) {
        case 'continue': {
          keptCounter.increment();
          out.push(original, DEFAULT_PORT);
          const [, ...extra] = outcome.events;
          for (const extraEvent of extra) {
            extraEvent.metadata.finalizers.merge(original.metadata.finalizers.clone());
            out.push(extraEvent, DEFAULT_PORT);
          }
          break;
        }
        case 'drop': {
          droppedCounter.increment();
          original.metadata.finalizers.finish('delivered');
          break;
        }
        case 'abort': {
          abortedCounter.increment();
          if (options.on_error === 'keep') {
            keptCounter.increment();
            out.push(original, DEFAULT_PORT);
          } else {
            droppedCounter.increment();
            discardedCounter.increment();
            original.metadata.finalizers.finish('rejected');
          }
          break;
        }
      }
    }

    return {
      start(context) {
        ctx = context;
        keptCounter = ctx.metrics.counter('filter_events_total', { result: 'kept' });
        droppedCounter = ctx.metrics.counter('filter_events_total', { result: 'dropped' });
        abortedCounter = ctx.metrics.counter(Metrics.errors, { reason: 'condition_aborted' });
        discardedCounter = ctx.metrics.counter(Metrics.discardedEvents, {
          reason: 'condition_aborted',
        });
      },
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          if (options.event_kind === 'span') {
            if (isSpanEvent(event)) {
              decide(program, spanEventToView(event), event, out);
              continue;
            }
          } else if (isLogEvent(event)) {
            decide(program, event, event, out);
            continue;
          }
          ctx.metrics.counter('filter_passthrough_events_total', { kind: event.kind }).increment();
          out.push(event, DEFAULT_PORT);
        }
      },
    };
  },
});
