import type { Event, LogEvent } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  Metrics,
  type Counter,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import type { Type } from '@ferrule/script';
import { compileScriptSource, wrapBooleanCondition } from './util/scriptCompile.js';
import { FIELD_KIND_NAMES, inputSchemaType } from './util/inputSchema.js';

/**
 * `filter` — keeps log events for which a Ferrule Script boolean expression is true.
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
 * Known limitation: because `condition` is compiled inside a synthetic wrapper source, a compile
 * error's reported position is an offset into `if !((<condition>) ?? <fallback>) { drop }`, not
 * into the `condition` string alone — the rendered code frame still shows the right source text
 * and column, just with the wrapper visible around it.
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
});

export type FilterOptions = Infer<typeof filterOptions>;

export const filterTransform = defineTransform<FilterOptions>({
  kind: 'transform',
  type: 'filter',
  description: 'Keeps log events for which a Ferrule Script boolean expression is true.',
  options: filterOptions,
  accepts: ['log'],
  examples: [{ title: 'Keep only 2xx/3xx responses', config: { condition: '.status < 400' } }],
  build: (options) => {
    const source = wrapBooleanCondition(options.condition, options.on_error === 'keep');
    const inputSchema = inputSchemaType(options.input_schema);
    const compileOpts: { inputSchema?: Type } = {};
    if (inputSchema !== undefined) compileOpts.inputSchema = inputSchema;
    const program = compileScriptSource(source, '<filter condition>', compileOpts);

    let ctx!: TransformContext;
    let keptCounter!: Counter;
    let droppedCounter!: Counter;
    let abortedCounter!: Counter;
    let discardedCounter!: Counter;

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
          const log = event as LogEvent;
          const outcome = program.run(log, { clock: () => ctx.clock.now() });
          switch (outcome.kind) {
            case 'continue': {
              keptCounter.increment();
              const [first, ...extra] = outcome.events;
              out.push(first ?? log, DEFAULT_PORT);
              for (const extraEvent of extra) {
                extraEvent.metadata.finalizers.merge(log.metadata.finalizers.clone());
                out.push(extraEvent, DEFAULT_PORT);
              }
              break;
            }
            case 'drop': {
              droppedCounter.increment();
              log.metadata.finalizers.finish('delivered');
              break;
            }
            case 'abort': {
              abortedCounter.increment();
              if (options.on_error === 'keep') {
                keptCounter.increment();
                out.push(log, DEFAULT_PORT);
              } else {
                droppedCounter.increment();
                discardedCounter.increment();
                log.metadata.finalizers.finish('rejected');
              }
              break;
            }
          }
        }
      },
    };
  },
});
