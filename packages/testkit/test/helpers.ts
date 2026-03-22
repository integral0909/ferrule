import type { Event, LogEvent } from '@ferrule/core';
import {
  ComponentRegistry,
  DEFAULT_PORT,
  defineSink,
  defineSource,
  defineTransform,
  type TransformOutput,
} from '@ferrule/runtime';
import { s } from '@ferrule/schema';

/**
 * Fixture component definitions shared by testkit's own test suite: a `fake_source`/`fake_sink`
 * pair whose `build()` is never actually invoked in a pipeline-runner test (the runner always
 * substitutes its own injection/collector stubs), registered only so `loadConfig` can validate a
 * fixture pipeline config's `type`/options, plus a couple of small real transforms to exercise.
 */

export const fakeSourceDefinition = defineSource<{ address?: string }>({
  kind: 'source',
  type: 'fake_source',
  description: 'a fixture source type, for pipeline config validation only',
  options: s.object({ address: s.string().optional() }),
  produces: () => ['log'],
  build: () => ({
    async run(ctx) {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  }),
});

export const fakeSinkDefinition = defineSink<Record<string, never>>({
  kind: 'sink',
  type: 'fake_sink',
  description: 'a fixture sink type, for pipeline config validation only',
  options: s.object({}),
  accepts: ['log', 'metric', 'span'],
  build: () => ({
    async run(ctx) {
      for await (const batch of ctx.input) {
        for (const event of batch) event.metadata.finalizers.finish('delivered');
      }
    },
  }),
});

/** Uppercases `.message` and drops events with `.skip == true`. */
export const upcaseTransformDefinition = defineTransform<Record<string, never>>({
  kind: 'transform',
  type: 'fake_upcase',
  description: 'uppercases .message; drops events with .skip == true',
  options: s.object({}),
  accepts: ['log'],
  build: () => ({
    process(events: Event[], out: TransformOutput) {
      for (const event of events) {
        const log = event as LogEvent;
        if (log.get('skip') === true) {
          log.metadata.finalizers.finish('delivered');
          continue;
        }
        const message = log.get('message');
        if (typeof message === 'string') log.set('message', message.toUpperCase());
        out.push(log, DEFAULT_PORT);
      }
    },
  }),
});

/**
 * A minimal `type: script` transform definition: it never actually compiles or runs Ferrule
 * Script (that's `@ferrule/operators`'s job; this package doesn't depend on it) — just enough of
 * the `source`/`file` option shape for `inlineScripts.ts`'s discovery-by-convention to find it in
 * a fixture config and for `loadConfig` to validate the fixture's options against something.
 */
export const fakeScriptTransformDefinition = defineTransform<{ source?: string; file?: string }>({
  kind: 'transform',
  type: 'script',
  description: "fixture stand-in for @ferrule/operators's script transform",
  options: s.object({ source: s.string().optional(), file: s.string().optional() }),
  accepts: ['log'],
  build: () => ({
    process(events: Event[], out: TransformOutput) {
      for (const event of events) out.push(event, DEFAULT_PORT);
    },
  }),
});

export function buildFixtureRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(
    fakeSourceDefinition,
    fakeSinkDefinition,
    upcaseTransformDefinition,
    fakeScriptTransformDefinition,
  );
  return registry;
}
