import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isFerruleError } from '@ferrule/core';
import {
  ConfigError,
  EnvSecretBackend,
  FileSecretBackend,
  loadConfig,
  renderDiagnostics as renderConfigDiagnostics,
  topologyIssuesToDiagnostics,
  toTopologySpec,
  type LoadedConfig,
  type SecretBackend,
  type TopologyOverrides,
} from '@ferrule/config';
import type { ComponentRegistry, TopologyIssue } from '@ferrule/runtime';
import { buildTopology, type Topology } from '@ferrule/runtime';
import type { ParsedArgs } from './args.js';
import { flagBoolean, flagString, flagStringArray } from './args.js';
import { UsageError } from './errors.js';

export interface SecretFlagOptions {
  readonly secretsDir?: string;
  readonly secretsEnvPrefix?: string;
}

/**
 * Reads `--secrets-dir`/`--secrets-env-prefix` and builds the corresponding `SecretBackend`.
 * Environment secrets are read from `env`, the CLI's environment, not the process's directly.
 */
export function secretBackendFromFlags(
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>>,
): SecretBackend | undefined {
  const dir = flagString(args, 'secrets-dir');
  const prefix = flagString(args, 'secrets-env-prefix');
  if (dir !== undefined && prefix !== undefined) {
    throw new UsageError('--secrets-dir and --secrets-env-prefix cannot both be given');
  }
  if (dir !== undefined) return new FileSecretBackend(dir);
  if (prefix !== undefined) return new EnvSecretBackend(prefix, env);
  return undefined;
}

export interface LoadCliConfigOptions {
  readonly registry: ComponentRegistry;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secretBackend?: SecretBackend;
}

/** Resolves `-c/--config` into one or more paths, relative to `cwd` when not absolute. */
export function configPathsFromFlags(args: ParsedArgs, cwd: string): string[] {
  const raw = flagStringArray(args, 'config');
  if (raw.length === 0) throw new UsageError('at least one -c/--config <file|dir> is required');
  return raw.map((p) => resolveMaybeRelative(p, cwd));
}

function resolveMaybeRelative(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Loads and validates configuration (schema-level, not topology-level). Throws `ConfigError`. */
export async function loadCliConfig(
  paths: readonly string[],
  options: LoadCliConfigOptions,
): Promise<LoadedConfig> {
  return loadConfig(paths, {
    registry: options.registry,
    env: options.env,
    ...(options.secretBackend !== undefined ? { secretBackend: options.secretBackend } : {}),
  });
}

/** Reads `--data-dir`, `--no-healthchecks`, `--shutdown-timeout` into `TopologyOverrides`. */
export function topologyOverridesFromFlags(args: ParsedArgs, cwd: string): TopologyOverrides {
  const overrides: { -readonly [K in keyof TopologyOverrides]: TopologyOverrides[K] } = {};
  const dataDir = flagString(args, 'data-dir');
  if (dataDir !== undefined) overrides.dataDir = resolveMaybeRelative(dataDir, cwd);
  if (flagBoolean(args, 'healthchecks', true) === false) overrides.disableHealthchecks = true;
  const shutdownFlag = args.flags.get('shutdown-timeout');
  if (typeof shutdownFlag === 'number') overrides.shutdownDeadlineMs = shutdownFlag;
  return overrides;
}

/** Converts a loaded config into a `TopologySpec`, applying CLI overrides. */
export function toCliTopologySpec(config: LoadedConfig, overrides: TopologyOverrides) {
  return toTopologySpec(config, overrides);
}

/**
 * Builds (validates + constructs component instances for) the topology described by `config`,
 * without starting a pipeline. Used by both `ferrule validate` and `ferrule run`.
 */
export async function buildCliTopology(
  config: LoadedConfig,
  registry: ComponentRegistry,
  overrides: TopologyOverrides,
): Promise<
  | { ok: true; topology: Topology; warnings: readonly TopologyIssue[] }
  | { ok: false; errors: readonly TopologyIssue[]; warnings: readonly TopologyIssue[] }
> {
  const spec = toCliTopologySpec(config, overrides);
  return buildTopology(spec, registry);
}

/** Renders a `ConfigError`'s diagnostics as code frames. */
export function renderConfigLoadError(error: ConfigError, color: boolean): string {
  return renderConfigDiagnostics(error.diagnostics, error.sources, { color });
}

/**
 * Renders topology issues (unknown inputs, cycles, build failures, ...) as code frames, re-reading
 * the config files involved so the original source text is available for the frame.
 */
export async function renderTopologyIssuesText(
  issues: readonly TopologyIssue[],
  config: LoadedConfig,
  color: boolean,
): Promise<string> {
  const diagnostics = topologyIssuesToDiagnostics(issues, config);
  const files = new Set(
    diagnostics.map((d) => d.file).filter((f) => f !== '(unknown)' && f !== '<config>'),
  );
  const sources = new Map<string, string>();
  for (const file of files) {
    try {
      sources.set(file, await readFile(file, 'utf8'));
    } catch {
      // Best effort: if the file can no longer be read, the diagnostic still prints without a frame.
    }
  }
  return renderConfigDiagnostics(diagnostics, sources, { color, secrets: config.secrets });
}

/** True if `error` is the `ConfigError` this package's dependencies throw for a bad config file. */
export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}

export function isKnownFerruleError(error: unknown): boolean {
  return isFerruleError(error);
}

/**
 * Expands `-c/--config` paths into the concrete files that back them, mirroring `loadConfig`'s
 * own directory expansion (`*.yaml`/`*.yml`/`*.json`, sorted). Used only by `ferrule run --watch`
 * to know which files' mtimes to poll; `loadConfig` itself re-does this expansion on every load.
 */
export async function expandConfigPathsForWatch(paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    let info;
    try {
      info = await stat(p);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const entries = await readdir(p);
      const matched = entries.filter((e) => /\.(ya?ml|json)$/i.test(e)).sort();
      for (const e of matched) files.push(join(p, e));
    } else {
      files.push(p);
    }
  }
  return files;
}
