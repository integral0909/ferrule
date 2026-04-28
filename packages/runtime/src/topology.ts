import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isFerruleError, type EventKind } from '@ferrule/core';
import { closestMatch, formatIssuePath } from '@ferrule/schema';
import {
  DEFAULT_PORT,
  type ComponentDefinition,
  type ComponentKind,
  type Logger,
  type Sink,
  type Source,
  type Transform,
} from './component.js';
import type { WhenFull } from './channel.js';
import { createNullLogger } from './logger.js';
import type { ComponentRegistry } from './registry.js';
import type { TopologyIssue } from './errors.js';

// -------------------------------------------------------------------------------------------
// Specification
// -------------------------------------------------------------------------------------------

/** One component's configuration, as it would come from a loaded (but not yet schema-validated) config file. */
export interface ComponentSpec {
  readonly type: string;
  /** Raw options, validated by {@link buildTopology} against the component definition's schema. */
  readonly options: unknown;
}

/** A component that consumes events: `inputs` names its upstream components (and optionally ports). */
export interface WiredComponentSpec extends ComponentSpec {
  /** References to upstream components: `componentId` (default port) or `componentId.port`. */
  readonly inputs: readonly string[];
}

export interface SinkBufferSpec {
  readonly whenFull?: WhenFull;
  readonly kind?: 'memory' | 'disk';
  /** Memory buffer event capacity. Ignored for `disk`. */
  readonly maxEvents?: number;
  /** Memory buffer byte capacity. Ignored for `disk`. */
  readonly maxBytes?: number;
  /** Options passed to the configured `bufferFactory` when `kind` is `disk`. */
  readonly disk?: Readonly<Record<string, unknown>>;
}

export interface SinkSpec extends WiredComponentSpec {
  readonly buffer?: SinkBufferSpec;
}

export interface GlobalSettings {
  /** Root directory for component durable state. Components that need one fail to build without it. */
  readonly dataDir?: string;
  readonly defaultChannelCapacityEvents?: number;
  readonly defaultChannelCapacityBytes?: number;
  /** Whether end-to-end acknowledgements are enabled pipeline-wide. */
  readonly acknowledgements?: boolean;
  readonly healthchecksEnabled?: boolean;
  readonly healthcheckTimeoutMs?: number;
  /** Deadline for graceful shutdown before remaining events are force-finalized as `errored`. */
  readonly shutdownDeadlineMs?: number;
  /** If true, a failing component is isolated instead of stopping the whole pipeline. */
  readonly continueOnComponentFailure?: boolean;
}

export interface TopologySpec {
  readonly sources: Readonly<Record<string, ComponentSpec>>;
  readonly transforms?: Readonly<Record<string, WiredComponentSpec>>;
  readonly sinks: Readonly<Record<string, SinkSpec>>;
  readonly settings?: GlobalSettings;
}

export interface ResolvedSettings {
  readonly dataDir: string | undefined;
  readonly defaultChannelCapacityEvents: number;
  readonly defaultChannelCapacityBytes: number;
  readonly acknowledgements: boolean;
  readonly healthchecksEnabled: boolean;
  readonly healthcheckTimeoutMs: number;
  readonly shutdownDeadlineMs: number;
  readonly continueOnComponentFailure: boolean;
}

const SETTINGS_DEFAULTS = {
  defaultChannelCapacityEvents: 10_000,
  defaultChannelCapacityBytes: 64 * 1024 * 1024,
  acknowledgements: false,
  healthchecksEnabled: true,
  healthcheckTimeoutMs: 5_000,
  shutdownDeadlineMs: 30_000,
  continueOnComponentFailure: false,
} as const;

export function resolveSettings(settings: GlobalSettings | undefined): ResolvedSettings {
  return {
    dataDir: settings?.dataDir,
    defaultChannelCapacityEvents:
      settings?.defaultChannelCapacityEvents ?? SETTINGS_DEFAULTS.defaultChannelCapacityEvents,
    defaultChannelCapacityBytes:
      settings?.defaultChannelCapacityBytes ?? SETTINGS_DEFAULTS.defaultChannelCapacityBytes,
    acknowledgements: settings?.acknowledgements ?? SETTINGS_DEFAULTS.acknowledgements,
    healthchecksEnabled: settings?.healthchecksEnabled ?? SETTINGS_DEFAULTS.healthchecksEnabled,
    healthcheckTimeoutMs: settings?.healthcheckTimeoutMs ?? SETTINGS_DEFAULTS.healthcheckTimeoutMs,
    shutdownDeadlineMs: settings?.shutdownDeadlineMs ?? SETTINGS_DEFAULTS.shutdownDeadlineMs,
    continueOnComponentFailure:
      settings?.continueOnComponentFailure ?? SETTINGS_DEFAULTS.continueOnComponentFailure,
  };
}

// -------------------------------------------------------------------------------------------
// Built topology
// -------------------------------------------------------------------------------------------

export interface InputRef {
  readonly componentId: string;
  readonly port: string;
}

/** Parses `componentId` or `componentId.port` into an {@link InputRef}. */
export function parseInputRef(ref: string): InputRef {
  const dot = ref.indexOf('.');
  return dot === -1
    ? { componentId: ref, port: DEFAULT_PORT }
    : { componentId: ref.slice(0, dot), port: ref.slice(dot + 1) };
}

export function formatInputRef(ref: InputRef): string {
  return ref.port === DEFAULT_PORT ? ref.componentId : `${ref.componentId}.${ref.port}`;
}

export interface BuiltComponent {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly type: string;
  readonly definition: ComponentDefinition;
  readonly options: unknown;
  readonly inputs: readonly InputRef[];
  readonly instance: Source | Transform | Sink;
  readonly bufferSpec: SinkBufferSpec | undefined;
  readonly producesKinds: readonly EventKind[];
  readonly declaredPorts: readonly string[];
  /** The directory reserved for this component's durable state, mirrored from its `BuildContext`. */
  readonly dataDir: string | undefined;
}

/** A fully validated and built pipeline graph, ready to run. */
export interface Topology {
  readonly spec: TopologySpec;
  readonly components: ReadonlyMap<string, BuiltComponent>;
  /** Component IDs in dependency order: every producer precedes its consumers. */
  readonly order: readonly string[];
  readonly settings: ResolvedSettings;
}

export type TopologyBuildResult =
  | { readonly ok: true; readonly topology: Topology; readonly warnings: readonly TopologyIssue[] }
  | {
      readonly ok: false;
      readonly errors: readonly TopologyIssue[];
      readonly warnings: readonly TopologyIssue[];
    };

export interface BuildTopologyOptions {
  readonly logger?: Logger;
}

interface Entry {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly spec: ComponentSpec | WiredComponentSpec | SinkSpec;
}

/**
 * Validates `spec` against `registry` (unknown types, options schemas, unknown/mistyped inputs,
 * cycles, sink-as-input, event-kind mismatches, unwired components) and, if there are no errors,
 * builds every component instance via its definition's `build`. Never throws: every problem,
 * including a build failure, is returned as an issue. On any error the returned result is `ok:
 * false` and nothing is built, so callers can validate configuration (e.g. for hot reload or
 * `ferrule validate`) without side effects.
 */
export async function buildTopology(
  spec: TopologySpec,
  registry: ComponentRegistry,
  options: BuildTopologyOptions = {},
): Promise<TopologyBuildResult> {
  const logger = options.logger ?? createNullLogger();
  const settings = resolveSettings(spec.settings);
  const errors: TopologyIssue[] = [];
  const warnings: TopologyIssue[] = [];

  const entries = collectEntries(spec, errors);
  const allIds = new Set(entries.map((e) => e.id));

  const definitions = new Map<string, ComponentDefinition>();
  const validatedOptions = new Map<string, unknown>();
  const declaredPorts = new Map<string, string[]>();

  for (const entry of entries) {
    let definition: ComponentDefinition;
    try {
      definition = registry.get(entry.kind, entry.spec.type);
    } catch (error) {
      errors.push({
        severity: 'error',
        code: 'E_UNKNOWN_COMPONENT_TYPE',
        message: error instanceof Error ? error.message : String(error),
        componentId: entry.id,
      });
      continue;
    }
    definitions.set(entry.id, definition);

    const parsed = definition.options.safeParse(entry.spec.options);
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        errors.push({
          severity: 'error',
          code: 'E_SCHEMA',
          message: `${formatIssuePath(issue.path)}: ${issue.message}`,
          componentId: entry.id,
        });
      }
      continue;
    }
    validatedOptions.set(entry.id, parsed.value);

    const ports = [DEFAULT_PORT];
    if (definition.kind !== 'sink' && definition.outputs !== undefined) {
      for (const p of definition.outputs(parsed.value)) ports.push(p.name);
    }
    declaredPorts.set(entry.id, ports);
  }

  const edges: { from: InputRef; to: string }[] = [];
  const inputsById = new Map<string, InputRef[]>();

  for (const entry of entries) {
    if (entry.kind === 'source') continue;
    const wired = entry.spec as WiredComponentSpec;
    if (wired.inputs.length === 0) {
      errors.push({
        severity: 'error',
        code: 'E_NO_INPUTS',
        message: `${entry.kind} has no inputs`,
        componentId: entry.id,
      });
    }
    const refs: InputRef[] = [];
    for (const raw of wired.inputs) {
      const ref = parseInputRef(raw);
      refs.push(ref);
      if (!allIds.has(ref.componentId)) {
        const suggestion = closestMatch(ref.componentId, allIds);
        errors.push({
          severity: 'error',
          code: 'E_UNKNOWN_INPUT',
          message:
            `unknown input ${JSON.stringify(formatInputRef(ref))}` +
            (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
          componentId: entry.id,
        });
        continue;
      }
      const refKind = entries.find((e) => e.id === ref.componentId)?.kind;
      if (refKind === 'sink') {
        errors.push({
          severity: 'error',
          code: 'E_SINK_AS_INPUT',
          message: `${JSON.stringify(ref.componentId)} is a sink and cannot be used as an input`,
          componentId: entry.id,
        });
        continue;
      }
      const ports = declaredPorts.get(ref.componentId);
      if (ports !== undefined && !ports.includes(ref.port)) {
        const suggestion = closestMatch(ref.port, ports);
        errors.push({
          severity: 'error',
          code: 'E_UNKNOWN_PORT',
          message:
            `${JSON.stringify(ref.componentId)} has no port ${JSON.stringify(ref.port)}` +
            (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
          componentId: entry.id,
        });
        continue;
      }
      edges.push({ from: ref, to: entry.id });
    }
    inputsById.set(entry.id, refs);
  }

  const cycle = findCycle(entries, edges);
  if (cycle !== undefined) {
    errors.push({
      severity: 'error',
      code: 'E_CYCLE',
      message: `cycle in pipeline graph: ${cycle.join(' -> ')}`,
    });
  }

  let order: string[] = [];
  if (cycle === undefined) {
    order = topologicalOrder(entries, edges);
    checkEventKinds(edges, definitions, validatedOptions, order, errors);
  }

  for (const entry of entries) {
    if (entry.kind !== 'source') continue;
    const used = edges.some((e) => e.from.componentId === entry.id);
    if (!used) {
      warnings.push({
        severity: 'warning',
        code: 'W_UNUSED_SOURCE',
        message: `source ${JSON.stringify(entry.id)} is not used as an input by any component`,
        componentId: entry.id,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const components = new Map<string, BuiltComponent>();
  for (const id of order) {
    const entry = entries.find((e) => e.id === id)!;
    const definition = definitions.get(id)!;
    const parsedOptions = validatedOptions.get(id);
    const inputs = inputsById.get(id) ?? [];
    const dataDir = await componentDataDir(settings.dataDir, id);
    const buildLogger = logger.child({ component: id });
    try {
      const instance = await definition.build(parsedOptions, {
        id,
        logger: buildLogger,
        dataDir,
        inputs: inputs.map((r) => r.componentId),
      });
      const producesKinds = producesFor(definition, parsedOptions, inputs, components);
      components.set(id, {
        id,
        kind: entry.kind,
        type: entry.spec.type,
        definition,
        options: parsedOptions,
        inputs,
        instance,
        bufferSpec: entry.kind === 'sink' ? (entry.spec as SinkSpec).buffer : undefined,
        producesKinds,
        declaredPorts: declaredPorts.get(id) ?? [DEFAULT_PORT],
        dataDir,
      });
    } catch (error) {
      errors.push({
        severity: 'error',
        code: isFerruleError(error) ? error.code : 'E_COMPONENT_BUILD_FAILED',
        message: error instanceof Error ? error.message : String(error),
        componentId: id,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    topology: { spec, components, order, settings },
    warnings,
  };
}

function collectEntries(spec: TopologySpec, errors: TopologyIssue[]): Entry[] {
  const entries: Entry[] = [];
  const seen = new Map<string, ComponentKind>();
  const add = (
    id: string,
    kind: ComponentKind,
    componentSpec: ComponentSpec | WiredComponentSpec,
  ): void => {
    const existing = seen.get(id);
    if (existing !== undefined) {
      errors.push({
        severity: 'error',
        code: 'E_DUPLICATE_ID',
        message: `component ID ${JSON.stringify(id)} is used more than once (as ${existing} and ${kind})`,
        componentId: id,
      });
      return;
    }
    seen.set(id, kind);
    entries.push({ id, kind, spec: componentSpec });
  };
  for (const [id, s] of Object.entries(spec.sources)) add(id, 'source', s);
  for (const [id, s] of Object.entries(spec.transforms ?? {})) add(id, 'transform', s);
  for (const [id, s] of Object.entries(spec.sinks)) add(id, 'sink', s);
  return entries;
}

async function componentDataDir(root: string | undefined, id: string): Promise<string | undefined> {
  if (root === undefined) return undefined;
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

function producesFor(
  definition: ComponentDefinition,
  options: unknown,
  inputs: readonly InputRef[],
  built: ReadonlyMap<string, BuiltComponent>,
): readonly EventKind[] {
  if (definition.kind === 'sink') return [];
  if (definition.kind === 'source') return definition.produces(options);
  const inputKinds = unionKinds(inputs, built);
  return definition.produces?.(options, inputKinds) ?? inputKinds;
}

function unionKinds(
  inputs: readonly InputRef[],
  built: ReadonlyMap<string, BuiltComponent>,
): EventKind[] {
  const kinds = new Set<EventKind>();
  for (const ref of inputs) {
    const producer = built.get(ref.componentId);
    if (producer === undefined) continue;
    for (const k of producer.producesKinds) kinds.add(k);
  }
  return [...kinds];
}

function findCycle(
  entries: readonly Entry[],
  edges: readonly { from: InputRef; to: string }[],
): string[] | undefined {
  const adjacency = new Map<string, string[]>();
  for (const entry of entries) adjacency.set(entry.id, []);
  for (const edge of edges) adjacency.get(edge.from.componentId)?.push(edge.to);

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const nextState = state.get(next);
      if (nextState === 'visiting') {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (nextState === undefined) {
        const found = visit(next);
        if (found !== undefined) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const entry of entries) {
    if (state.has(entry.id)) continue;
    const found = visit(entry.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function topologicalOrder(
  entries: readonly Entry[],
  edges: readonly { from: InputRef; to: string }[],
): string[] {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const entry of entries) {
    indegree.set(entry.id, 0);
    adjacency.set(entry.id, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from.componentId)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = entries.filter((e) => indegree.get(e.id) === 0).map((e) => e.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return order;
}

function checkEventKinds(
  edges: readonly { from: InputRef; to: string }[],
  definitions: ReadonlyMap<string, ComponentDefinition>,
  validatedOptions: ReadonlyMap<string, unknown>,
  order: readonly string[],
  errors: TopologyIssue[],
): void {
  const produced = new Map<string, readonly EventKind[]>();
  const inputsOf = new Map<string, InputRef[]>();
  for (const edge of edges) {
    const list = inputsOf.get(edge.to) ?? [];
    list.push(edge.from);
    inputsOf.set(edge.to, list);
  }
  for (const id of order) {
    const definition = definitions.get(id);
    const options = validatedOptions.get(id);
    if (definition === undefined || options === undefined) {
      produced.set(id, []);
      continue;
    }
    if (definition.kind === 'source') {
      produced.set(id, definition.produces(options));
      continue;
    }
    const refs = inputsOf.get(id) ?? [];
    const inputKinds = new Set<EventKind>();
    for (const ref of refs) for (const k of produced.get(ref.componentId) ?? []) inputKinds.add(k);
    const inputKindList = [...inputKinds];

    if (inputKindList.length > 0 && !inputKindList.some((k) => definition.accepts.includes(k))) {
      errors.push({
        severity: 'error',
        code: 'E_EVENT_KIND_MISMATCH',
        message:
          `accepts [${definition.accepts.join(', ')}] but its inputs produce ` +
          `[${inputKindList.join(', ')}]`,
        componentId: id,
      });
    }

    if (definition.kind === 'sink') {
      produced.set(id, []);
    } else {
      produced.set(id, definition.produces?.(options, inputKindList) ?? inputKindList);
    }
  }
}
