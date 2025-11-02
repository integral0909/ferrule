import type { Event } from '@ferrule/core';
import { LogEvent } from '@ferrule/core';
import {
  ComponentRegistry,
  MetricsRegistry,
  Pipeline,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  defineSink,
  type Collector,
  type ScriptedSourceHandle,
  type TopologySpec,
} from '@ferrule/runtime';
import { createAdminServer } from '../src/server.js';
import type { AdminServer, AdminServerOptions } from '../src/types.js';

/**
 * Test fixtures build real `Pipeline`s from `@ferrule/runtime`'s testing helpers — a scripted
 * source and a collecting sink — rather than mocks, per the package's testing conventions. Every
 * admin endpoint is exercised against an actual running pipeline and an actual `node:http`
 * server bound to `127.0.0.1:0`.
 */

export const SOURCE_TYPE = 'admin_test_source';
export const SINK_TYPE = 'admin_test_sink';

export interface ScriptStepInit {
  readonly events: readonly Event[];
  readonly delayMs?: number;
}

export interface Harness {
  readonly pipeline: Pipeline;
  readonly metrics: MetricsRegistry;
  readonly registry: ComponentRegistry;
  readonly sourceHandle: ScriptedSourceHandle;
  readonly collector: Collector;
  readonly spec: TopologySpec;
  stop(): Promise<void>;
}

function defaultSteps(): ScriptStepInit[] {
  return [{ events: [LogEvent.fromMessage('hello'), LogEvent.fromMessage('world')] }];
}

/** A two-component pipeline (`in` -> `out`) built from the scripted source / collecting sink
 * testing helpers, already started. */
export async function createHarness(
  steps: readonly ScriptStepInit[] = defaultSteps(),
): Promise<Harness> {
  const { definition: sourceDef, handle: sourceHandle } = createScriptedSourceDefinition(steps, {
    type: SOURCE_TYPE,
  });
  const { definition: sinkDef, collector } = createCollectingSinkDefinition({ type: SINK_TYPE });
  const registry = new ComponentRegistry();
  registry.register(sourceDef, sinkDef);
  const spec: TopologySpec = {
    sources: { in: { type: sourceDef.type, options: {} } },
    sinks: { out: { type: sinkDef.type, options: {}, inputs: ['in'] } },
  };
  const metrics = new MetricsRegistry();
  const pipeline = await Pipeline.create(spec, { registry, metrics });
  await pipeline.start();
  return {
    pipeline,
    metrics,
    registry,
    sourceHandle,
    collector,
    spec,
    stop: () => pipeline.stop(),
  };
}

/**
 * A pipeline whose one sink always throws (component state `failed`), with
 * `continueOnComponentFailure: true` so the pipeline itself keeps running and stabilizes at
 * `overall: degraded` instead of cascading into a shutdown — a stable, non-racy state to poll for
 * the "not running" health-status tests. Reusing an existing helper's already-built `{}` options
 * schema avoids this test file needing its own `@ferrule/schema` dependency.
 */
export async function createDegradedHarness(): Promise<Harness> {
  const { definition: sourceDef, handle: sourceHandle } = createScriptedSourceDefinition(
    defaultSteps(),
    { type: SOURCE_TYPE },
  );
  const { definition: baseSinkDef } = createCollectingSinkDefinition({ type: 'admin_test_unused' });
  const failingSinkDef = defineSink<Record<string, never>>({
    kind: 'sink',
    type: SINK_TYPE,
    description: 'always fails to run, for admin health tests',
    options: baseSinkDef.options,
    accepts: ['log'],
    build: () => ({
      run: () => Promise.reject(new Error('simulated sink failure')),
    }),
  });
  const registry = new ComponentRegistry();
  registry.register(sourceDef, failingSinkDef);
  const spec: TopologySpec = {
    sources: { in: { type: sourceDef.type, options: {} } },
    sinks: { out: { type: failingSinkDef.type, options: {}, inputs: ['in'] } },
    settings: { continueOnComponentFailure: true, healthchecksEnabled: false },
  };
  const metrics = new MetricsRegistry();
  const pipeline = await Pipeline.create(spec, { registry, metrics });
  await pipeline.start();
  // The sink fails as soon as it's driven; wait for that to actually land before returning, so
  // callers see a stable `degraded` state immediately rather than a flash of `starting`.
  while (pipeline.health().overall !== 'degraded') {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    pipeline,
    metrics,
    registry,
    sourceHandle,
    collector: { batches: [], events: [] },
    spec,
    stop: () => pipeline.stop(),
  };
}

export interface StartedAdmin {
  readonly server: AdminServer;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Starts a real admin server on `127.0.0.1:0` for one test. */
export async function startAdmin(
  options: Omit<AdminServerOptions, 'address'> & {
    readonly address?: AdminServerOptions['address'];
  },
): Promise<StartedAdmin> {
  const { address, ...rest } = options;
  const server = createAdminServer({ ...rest, address: address ?? { host: '127.0.0.1', port: 0 } });
  const bound = await server.start();
  return {
    server,
    baseUrl: `http://${bound.host}:${bound.port}`,
    stop: () => server.stop(),
  };
}

/** Both together: a running pipeline and a running admin server in front of it. Callers must
 * `stop()` both, admin first, in a `finally` / `afterEach`. */
export async function createAdminHarness(
  options: Partial<Omit<AdminServerOptions, 'pipeline' | 'metrics' | 'address'>> = {},
  steps?: readonly ScriptStepInit[],
): Promise<Harness & StartedAdmin> {
  const harness = await createHarness(steps);
  const admin = await startAdmin({
    pipeline: harness.pipeline,
    metrics: harness.metrics,
    ...options,
  });
  return {
    ...harness,
    ...admin,
    stop: async () => {
      await admin.stop();
      await harness.stop();
    },
  };
}
