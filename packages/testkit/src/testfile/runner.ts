import { fromPlain, type Event, type Value } from '@ferrule/core';
import { loadConfig, toTopologySpec, type LoadedConfig } from '@ferrule/config';
import {
  ComponentRegistry,
  defineSink,
  defineSource,
  ManualClock,
  Pipeline,
  type ComponentDefinition,
  type Logger,
  type SinkDefinition,
  type SourceContext,
  type SourceDefinition,
  type TopologySpec,
} from '@ferrule/runtime';
import { s } from '@ferrule/schema';
import type { CompiledProgram } from '@ferrule/script';
import { diffValues, eventToValue, formatDiffs } from '../diff.js';
import { compileCondition, evaluateCondition } from '../scriptCondition.js';
import { eventFromInputSpec } from './eventSpec.js';
import type { LoadedTestFile } from './loader.js';
import type { OutputExpectation, TestCase } from './schema.js';

/**
 * The pipeline test runner behind `ferrule test`: builds the topology `testFile.config` names
 * with every source replaced by an injection point and every sink replaced by a collector (so no
 * network is ever touched), runs each case with a fresh `ManualClock`, injects `inputs`, drains
 * the pipeline, and checks `outputs` expectations.
 */

const STUB_SOURCE_TYPE = '__testkit_inject__';
const STUB_SINK_TYPE = '__testkit_collect__';
const STOP_TIMEOUT_MS = 15_000;

interface SourceSlot {
  ctx: SourceContext | undefined;
  readonly ready: Promise<void>;
}

interface CollectorSlot {
  readonly events: Event[];
}

function createInjectionSourceDefinition(
  slots: Map<string, SourceSlot>,
): SourceDefinition<Record<string, never>> {
  return defineSource<Record<string, never>>({
    kind: 'source',
    type: STUB_SOURCE_TYPE,
    description: 'testkit pipeline test injection point (replaces the real source)',
    options: s.object({}),
    produces: () => ['log', 'metric', 'span'],
    build: (_options, buildCtx) => {
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const slot: SourceSlot = { ctx: undefined, ready };
      slots.set(buildCtx.id, slot);
      return {
        async run(ctx) {
          slot.ctx = ctx;
          resolveReady();
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              resolve();
              return;
            }
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      };
    },
  });
}

function createCollectorSinkDefinition(
  slots: Map<string, CollectorSlot>,
): SinkDefinition<Record<string, never>> {
  return defineSink<Record<string, never>>({
    kind: 'sink',
    type: STUB_SINK_TYPE,
    description: 'testkit pipeline test collector (replaces the real sink)',
    options: s.object({}),
    accepts: ['log', 'metric', 'span'],
    build: (_options, buildCtx) => {
      const slot: CollectorSlot = { events: [] };
      slots.set(buildCtx.id, slot);
      return {
        async run(ctx) {
          for await (const batch of ctx.input) {
            for (const event of batch) {
              slot.events.push(event);
              event.metadata.finalizers.finish('delivered');
            }
          }
        },
      };
    },
  });
}

function stubbedSpec(base: TopologySpec): TopologySpec {
  const sources: Record<string, { type: string; options: unknown }> = {};
  for (const id of Object.keys(base.sources)) sources[id] = { type: STUB_SOURCE_TYPE, options: {} };

  const sinks: Record<string, { type: string; options: unknown; inputs: readonly string[] }> = {};
  for (const [id, sinkSpec] of Object.entries(base.sinks)) {
    sinks[id] = { type: STUB_SINK_TYPE, options: {}, inputs: sinkSpec.inputs };
  }

  const spec: {
    sources: typeof sources;
    sinks: typeof sinks;
    transforms?: TopologySpec['transforms'];
    settings?: TopologySpec['settings'];
  } = { sources, sinks };
  if (base.transforms !== undefined) spec.transforms = base.transforms;
  if (base.settings !== undefined) spec.settings = base.settings;
  return spec as TopologySpec;
}

function withTimeout(promise: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface CaseFailure {
  readonly message: string;
}

export interface CaseResult {
  readonly name: string;
  readonly file: string;
  readonly passed: boolean;
  readonly failures: readonly CaseFailure[];
}

export interface TestFileResult {
  readonly file: string;
  readonly configPath: string;
  readonly cases: readonly CaseResult[];
}

export interface PipelineTestOptions {
  /** Every component type the config under test may use: real sources/sinks (for config validation) and every transform under test. */
  readonly registry: ComponentRegistry;
  readonly logger?: Logger;
}

export async function loadPipelineConfig(
  loaded: LoadedTestFile,
  registry: ComponentRegistry,
): Promise<LoadedConfig> {
  return loadConfig(loaded.configPath, { registry });
}

async function runCase(
  file: string,
  configPath: string,
  baseSpec: TopologySpec,
  transformDefinitions: readonly ComponentDefinition[],
  testCase: TestCase,
  options: PipelineTestOptions,
): Promise<CaseResult> {
  const sourceSlots = new Map<string, SourceSlot>();
  const sinkSlots = new Map<string, CollectorSlot>();
  const registry = new ComponentRegistry();
  registry.register(
    ...transformDefinitions,
    createInjectionSourceDefinition(sourceSlots),
    createCollectorSinkDefinition(sinkSlots),
  );

  const spec = stubbedSpec(baseSpec);
  const clock = new ManualClock();
  const failures: CaseFailure[] = [];

  const buildOptions: { registry: ComponentRegistry; clock: ManualClock; logger?: Logger } = {
    registry,
    clock,
  };
  if (options.logger !== undefined) buildOptions.logger = options.logger;
  const pipeline = await Pipeline.create(spec, buildOptions);
  await pipeline.start();
  await Promise.all([...sourceSlots.values()].map((slot) => slot.ready));

  for (const [sourceId, items] of testCase.inputs) {
    const slot = sourceSlots.get(sourceId);
    if (slot === undefined) {
      failures.push({
        message: `unknown input component ${JSON.stringify(sourceId)} (not a source in ${configPath})`,
      });
      continue;
    }
    const injected = items.map((item) => eventFromInputSpec(item));
    await slot.ctx!.output.send(injected);
  }

  if (testCase.advance_clock !== undefined) await clock.advance(testCase.advance_clock);

  await withTimeout(
    pipeline.stop(),
    STOP_TIMEOUT_MS,
    `case ${JSON.stringify(testCase.name)}: pipeline.stop()`,
  );

  for (const [sinkId, expectation] of testCase.outputs) {
    const slot = sinkSlots.get(sinkId);
    if (slot === undefined) {
      failures.push({
        message: `unknown output component ${JSON.stringify(sinkId)} (not a sink in ${configPath})`,
      });
      continue;
    }
    failures.push(...evaluateSinkExpectation(sinkId, slot.events, expectation));
  }

  return { name: testCase.name, file, passed: failures.length === 0, failures };
}

function evaluateSinkExpectation(
  sinkId: string,
  actual: readonly Event[],
  expectation: OutputExpectation,
): CaseFailure[] {
  const failures: CaseFailure[] = [];

  if (expectation.none === true && actual.length !== 0) {
    failures.push({ message: `${sinkId}: expected no events, got ${actual.length}` });
  }
  if (expectation.count !== undefined && actual.length !== expectation.count) {
    failures.push({
      message: `${sinkId}: expected ${expectation.count} event(s), got ${actual.length}`,
    });
  }
  if (expectation.events !== undefined) {
    expectation.events.forEach((rawExpected, i) => {
      const actualEvent = actual[i];
      if (actualEvent === undefined) {
        failures.push({
          message: `${sinkId}: events[${i}]: expected an event, but only ${actual.length} were collected`,
        });
        return;
      }
      const expectedValue = toExpectedValue(rawExpected);
      const diffs = diffValues(expectedValue, eventToValue(actualEvent), expectation.match);
      if (diffs.length > 0) {
        failures.push({ message: `${sinkId}: events[${i}] mismatch:\n${formatDiffs(diffs)}` });
      }
    });
  }
  if (expectation.conditions !== undefined) {
    for (const source of expectation.conditions) {
      let program: CompiledProgram;
      try {
        program = compileCondition(source, `${sinkId} condition`);
      } catch (error) {
        failures.push({
          message: `${sinkId}: condition ${JSON.stringify(source)} failed to compile: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
      actual.forEach((event, i) => {
        if (event.kind !== 'log') {
          failures.push({
            message: `${sinkId}: events[${i}]: conditions only evaluate against log events (got ${event.kind})`,
          });
          return;
        }
        const result = evaluateCondition(program, event);
        if (!result.ok) {
          failures.push({
            message: `${sinkId}: events[${i}]: condition ${JSON.stringify(source)} errored: ${result.reason}`,
          });
        } else if (!result.matched) {
          failures.push({
            message: `${sinkId}: events[${i}]: condition ${JSON.stringify(source)} was false`,
          });
        }
      });
    }
  }
  return failures;
}

function toExpectedValue(raw: unknown): Value {
  return fromPlain(raw);
}

/** Runs every case in one loaded test file. */
export async function runTestFile(
  loaded: LoadedTestFile,
  options: PipelineTestOptions,
): Promise<TestFileResult> {
  const config = await loadPipelineConfig(loaded, options.registry);
  const baseSpec = toTopologySpec(config);
  const transformDefinitions = options.registry.list('transform');

  const cases: CaseResult[] = [];
  for (const testCase of loaded.testFile.cases) {
    cases.push(
      await runCase(
        loaded.file,
        loaded.configPath,
        baseSpec,
        transformDefinitions,
        testCase,
        options,
      ),
    );
  }
  return { file: loaded.file, configPath: loaded.configPath, cases };
}

/** Runs several already-loaded test files in sequence. */
export async function runTestFiles(
  files: readonly LoadedTestFile[],
  options: PipelineTestOptions,
): Promise<TestFileResult[]> {
  const results: TestFileResult[] = [];
  for (const file of files) results.push(await runTestFile(file, options));
  return results;
}
