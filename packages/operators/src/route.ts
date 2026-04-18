import type { Event, LogEvent } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  Metrics,
  type Counter,
  type OutputPort,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import type { CompiledProgram, Type } from '@ferrule/script';
import { compileConditionSource } from './util/scriptCompile.js';
import { FIELD_KIND_NAMES, inputSchemaType } from './util/inputSchema.js';

/**
 * `route` — sends each log event to every named route whose Ferrule Script boolean condition is
 * true, using the same `if !((<condition>) ?? <fallback>) { drop }` compilation approach as
 * `filter` (see that module's doc comment for the full rationale). A route's port is its own
 * name; an event matching several routes is fanned out to all of them (the first match reuses the
 * original event object, every later match gets `LogEvent.clone()` — which already clones
 * finalizers, so acknowledgement of the upstream batch waits for every copy). An event matching
 * none of them goes to `unmatched_port` (default `_unmatched`), unless `route_unmatched` is
 * `false`, in which case it is finished `delivered` and counted.
 *
 * Each route's condition is evaluated independently against the *original* event — a condition
 * is a single expression, which the grammar cannot give an assignment statement (`.x = y` is a
 * `Statement`, never valid inside an expression), so evaluating several conditions in sequence
 * against the same event is safe: no route's condition can mutate the fields another route reads.
 * A route condition that calls `emit()` is a known, documented gap: the extra event is discarded
 * rather than routed anywhere, since with several routes possibly matching there is no single
 * obvious port to deliver it to — write route conditions as pure predicates.
 *
 * `on_error` governs what an `abort` (an explicit `abort()`, or an `any`-typed runtime mismatch —
 * not interceptable by `??`; see `filter`'s doc comment) means for that one route's match
 * decision: `keep` counts as matched, `drop` (the default) counts as not matched. It does not
 * affect a `Failure` (a fallible sub-expression), which `?? <fallback>` already resolves to an
 * ordinary `true`/`false` at compile time, same as `filter`.
 */

const routeSpec = s.object({
  name: s.string({ minLength: 1 }).describe("route name; also this route's output port"),
  condition: s.string({ minLength: 1 }).describe('a Ferrule Script boolean expression'),
});

export type RouteSpec = Infer<typeof routeSpec>;

export const routeOptions = s
  .object({
    routes: s.array(routeSpec, { minItems: 1 }).describe('named routes, tested in order'),
    on_error: s
      .enum(['keep', 'drop'] as const)
      .default('drop')
      .describe(
        'what an aborted route condition means for that route: keep = counts as matched, ' +
          'drop = counts as not matched (default)',
      ),
    route_unmatched: s
      .boolean()
      .default(true)
      .describe(
        'route events matching no route to `unmatched_port`; if false, drop and count them',
      ),
    unmatched_port: s
      .string({ minLength: 1 })
      .default('_unmatched')
      .describe('port for events matching no route (used only when route_unmatched is true)'),
    input_schema: s
      .record(s.enum(FIELD_KIND_NAMES))
      .optional()
      .describe('declarative field -> type map used to type .field paths in every condition'),
  })
  .refine(
    (o) => new Set(o.routes.map((r) => r.name)).size === o.routes.length,
    'route names must be unique',
  )
  .refine(
    (o) => !o.route_unmatched || !o.routes.some((r) => r.name === o.unmatched_port),
    'unmatched_port must not be the same as a route name',
  );

export type RouteOptions = Infer<typeof routeOptions>;

export const routeTransform = defineTransform<RouteOptions>({
  kind: 'transform',
  type: 'route',
  description: 'Sends log events to every named route whose Ferrule Script condition matches.',
  options: routeOptions,
  accepts: ['log'],
  outputs: (options): readonly OutputPort[] => {
    const ports: OutputPort[] = options.routes.map((r) => ({
      name: r.name,
      description: `events matching route ${JSON.stringify(r.name)}`,
    }));
    if (options.route_unmatched) {
      ports.push({ name: options.unmatched_port, description: 'events matching no route' });
    }
    return ports;
  },
  examples: [
    {
      title: 'Split by status class',
      config: {
        routes: [
          { name: 'errors', condition: '.status >= 500' },
          { name: 'client_errors', condition: '.status >= 400 && .status < 500' },
        ],
        unmatched_port: 'ok',
        route_unmatched: true,
      },
    },
  ],
  build: (options) => {
    const inputSchema = inputSchemaType(options.input_schema);
    const compileOpts: { inputSchema?: Type } = {};
    if (inputSchema !== undefined) compileOpts.inputSchema = inputSchema;
    const routePrograms: readonly { name: string; program: CompiledProgram }[] = options.routes.map(
      (route) => ({
        name: route.name,
        program: compileConditionSource(
          route.condition,
          options.on_error === 'keep',
          `<route ${JSON.stringify(route.name)}>`,
          compileOpts,
        ),
      }),
    );

    let ctx!: TransformContext;
    let routeCounters!: Map<string, Counter>;
    let abortedCounter!: Counter;
    let unmatchedCounter!: Counter;
    let unmatchedDiscardedCounter!: Counter;

    return {
      start(context) {
        ctx = context;
        routeCounters = new Map(
          routePrograms.map(({ name }) => [
            name,
            ctx.metrics.counter('route_events_total', { route: name }),
          ]),
        );
        abortedCounter = ctx.metrics.counter(Metrics.errors, { reason: 'condition_aborted' });
        unmatchedCounter = ctx.metrics.counter('route_events_total', { route: 'unmatched' });
        unmatchedDiscardedCounter = ctx.metrics.counter(Metrics.discardedEvents, {
          reason: 'unmatched',
        });
      },
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          const log = event as LogEvent;
          const matchedNames: string[] = [];
          for (const { name, program } of routePrograms) {
            const outcome = program.run(log, { clock: () => ctx.clock.now() });
            if (outcome.kind === 'continue') {
              matchedNames.push(name);
            } else if (outcome.kind === 'abort') {
              abortedCounter.increment();
              if (options.on_error === 'keep') matchedNames.push(name);
            }
          }

          if (matchedNames.length === 0) {
            if (options.route_unmatched) {
              unmatchedCounter.increment();
              out.push(log, options.unmatched_port);
            } else {
              unmatchedCounter.increment();
              unmatchedDiscardedCounter.increment();
              log.metadata.finalizers.finish('delivered');
            }
            continue;
          }

          matchedNames.forEach((name, i) => {
            routeCounters.get(name)!.increment();
            const target = i === 0 ? log : log.clone();
            out.push(target, name);
          });
        }
      },
    };
  },
});
