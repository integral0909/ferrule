import type { EventKind } from '@ferrule/core';
import { s } from '@ferrule/schema';
import {
  ComponentRegistry,
  DEFAULT_PORT,
  defineSink,
  defineSource,
  defineTransform,
  type OutputPort,
  type SinkDefinition,
  type SourceDefinition,
  type TransformDefinition,
} from '@ferrule/runtime';

/** Minimal, generic test definitions for exercising topology building and pipeline wiring. */

export function basicSourceDefinition(
  type: string,
  options: { produces?: EventKind[]; outputs?: OutputPort[] } = {},
): SourceDefinition<Record<string, never>> {
  return defineSource({
    kind: 'source',
    type,
    description: 'test source',
    options: s.object({}),
    produces: () => options.produces ?? ['log'],
    ...(options.outputs !== undefined ? { outputs: () => options.outputs! } : {}),
    build: () => ({
      run: (ctx) =>
        new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    }),
  });
}

export function basicTransformDefinition(
  type: string,
  options: {
    accepts?: EventKind[];
    produces?: (opts: Record<string, never>, kinds: readonly EventKind[]) => readonly EventKind[];
    outputs?: OutputPort[];
  } = {},
): TransformDefinition<Record<string, never>> {
  return defineTransform({
    kind: 'transform',
    type,
    description: 'test transform',
    options: s.object({}),
    accepts: options.accepts ?? ['log'],
    ...(options.produces !== undefined ? { produces: options.produces } : {}),
    ...(options.outputs !== undefined ? { outputs: () => options.outputs! } : {}),
    build: () => ({
      process: (events, out) => {
        for (const event of events) out.push(event, DEFAULT_PORT);
      },
    }),
  });
}

export function basicSinkDefinition(
  type: string,
  options: { accepts?: EventKind[] } = {},
): SinkDefinition<Record<string, never>> {
  return defineSink({
    kind: 'sink',
    type,
    description: 'test sink',
    options: s.object({}),
    accepts: options.accepts ?? ['log'],
    build: () => ({
      run: async (ctx) => {
        for await (const batch of ctx.input) {
          for (const event of batch) event.metadata.finalizers.finish('delivered');
        }
      },
    }),
  });
}

export function createRegistry(
  ...definitions: (SourceDefinition | TransformDefinition | SinkDefinition)[]
): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(...definitions);
  return registry;
}
