import type {
  ComponentSpec,
  GlobalSettings as RuntimeSettings,
  SinkBufferSpec,
  SinkSpec,
  TopologyIssue,
  TopologySpec,
  WiredComponentSpec,
} from '@ferrule/runtime';
import type { ConfigDiagnostic } from './diagnostics.js';
import type { LoadedComponent, LoadedConfig } from './loader.js';
import type { BufferConfig, ComponentInputRef } from './model.js';

/** Settings that come from the command line or embedding code rather than the config file. */
export interface TopologyOverrides {
  /** Overrides `data_dir` from the config. */
  readonly dataDir?: string;
  readonly shutdownDeadlineMs?: number;
  readonly continueOnComponentFailure?: boolean;
  /** Disables startup health checks regardless of the config (`ferrule run --no-healthchecks`). */
  readonly disableHealthchecks?: boolean;
}

/**
 * Converts a loaded configuration into the runtime's {@link TopologySpec}.
 *
 * The runtime validates options against each component's schema again when it builds the
 * topology, so the spec carries the interpolated *raw* options rather than the parsed ones;
 * this keeps one validation path for configs, reloads, and programmatic pipelines alike.
 */
export function toTopologySpec(
  config: LoadedConfig,
  overrides: TopologyOverrides = {},
): TopologySpec {
  const sources: Record<string, ComponentSpec> = {};
  const transforms: Record<string, WiredComponentSpec> = {};
  const sinks: Record<string, SinkSpec> = {};

  for (const component of config.sources.values()) {
    sources[component.id] = { type: component.type, options: component.rawOptions };
  }
  for (const component of config.transforms.values()) {
    transforms[component.id] = {
      type: component.type,
      options: component.rawOptions,
      inputs: component.inputs.map(formatInputRef),
    };
  }
  for (const component of config.sinks.values()) {
    const spec: { -readonly [K in keyof SinkSpec]: SinkSpec[K] } = {
      type: component.type,
      options: component.rawOptions,
      inputs: component.inputs.map(formatInputRef),
    };
    if (component.buffer !== undefined) spec.buffer = toBufferSpec(component.buffer);
    sinks[component.id] = spec;
  }

  const settings: { -readonly [K in keyof RuntimeSettings]: RuntimeSettings[K] } = {
    acknowledgements: config.acknowledgements,
    healthchecksEnabled:
      overrides.disableHealthchecks === true ? false : config.healthchecks.enabled,
    healthcheckTimeoutMs: config.healthchecks.timeout,
  };
  const dataDir = overrides.dataDir ?? config.dataDir;
  if (dataDir !== undefined) settings.dataDir = dataDir;
  if (overrides.shutdownDeadlineMs !== undefined) {
    settings.shutdownDeadlineMs = overrides.shutdownDeadlineMs;
  }
  if (overrides.continueOnComponentFailure !== undefined) {
    settings.continueOnComponentFailure = overrides.continueOnComponentFailure;
  }
  return { sources, transforms, sinks, settings };
}

/** `id` or `id.port`, the form the runtime expects. */
export function formatInputRef(ref: ComponentInputRef): string {
  return ref.port === undefined ? ref.id : `${ref.id}.${ref.port}`;
}

function toBufferSpec(buffer: BufferConfig): SinkBufferSpec {
  if (buffer.type === 'memory') {
    return buffer.max_events === undefined
      ? { kind: 'memory' }
      : { kind: 'memory', maxEvents: buffer.max_events };
  }
  const disk: Record<string, unknown> = {};
  if (buffer.max_size !== undefined) disk['maxBufferBytes'] = buffer.max_size;
  return { kind: 'disk', whenFull: buffer.when_full, disk };
}

/**
 * Maps runtime topology issues (unknown inputs, cycles, build failures) back onto the config
 * file, pointing at the offending component's definition so they render with code frames like
 * any other configuration error.
 */
export function topologyIssuesToDiagnostics(
  issues: readonly TopologyIssue[],
  config: LoadedConfig,
): ConfigDiagnostic[] {
  const byId = new Map<string, LoadedComponent>(config.components.map((c) => [c.id, c]));
  const fallbackFile = config.components[0]?.location.file ?? '<config>';
  return issues.map((issue) => {
    const component = issue.componentId === undefined ? undefined : byId.get(issue.componentId);
    const prefix = issue.severity === 'error' ? '' : 'warning: ';
    return {
      file: component?.location.file ?? fallbackFile,
      range: component?.location.range,
      message: `${prefix}${issue.componentId === undefined ? '' : `${issue.componentId}: `}${issue.message}`,
      code: issue.code,
    };
  });
}
