import { FerruleError, ParseError } from '@ferrule/core';
import type { ComponentDefinition, ComponentKind, ComponentRegistry } from '@ferrule/runtime';
import { closestMatch, COMPONENT_ID, invalid, ParseContext } from '@ferrule/schema';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigError, issueToDiagnostic, type ConfigDiagnostic } from './diagnostics.js';
import { interpolateTree, type InterpolationContext } from './interpolation.js';
import { readJsonDocument } from './json-reader.js';
import type { SourceLocation } from './position.js';
import {
  bufferSchema,
  COMPONENT_SECTION_KEYS,
  globalSettingsSchema,
  GLOBAL_SETTINGS_KEYS,
  TOP_LEVEL_KEYS,
  validateComponentEntry,
  type BufferConfig,
  type ComponentInputRef,
  type GlobalSettings,
} from './model.js';
import { defineField, nodeToPlain, PositionMap } from './yaml/nodes.js';
import { emitYaml } from './yaml/emitter.js';
import { parseYamlDocument } from './yaml/parser.js';
import type { SecretBackend } from './secrets.js';
import { SecretRegistry } from './secrets.js';

export interface LoadConfigOptions {
  readonly registry: ComponentRegistry;
  /** Environment variables for `${VAR}` interpolation. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Backend for `${secret:NAME}`. Omit to make `${secret:...}` an error. */
  readonly secretBackend?: SecretBackend;
}

export interface LoadedComponent {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly type: string;
  readonly definition: ComponentDefinition;
  readonly options: unknown;
  readonly rawOptions: unknown;
  readonly inputs: readonly ComponentInputRef[];
  readonly buffer?: BufferConfig;
  readonly acknowledgements?: boolean;
  readonly location: SourceLocation;
}

export interface LoadedConfig {
  readonly dataDir: string | undefined;
  readonly acknowledgements: boolean;
  readonly log: GlobalSettings['log'];
  readonly api: GlobalSettings['api'];
  readonly healthchecks: GlobalSettings['healthchecks'];
  readonly sources: ReadonlyMap<string, LoadedComponent>;
  readonly transforms: ReadonlyMap<string, LoadedComponent>;
  readonly sinks: ReadonlyMap<string, LoadedComponent>;
  readonly components: readonly LoadedComponent[];
  readonly secrets: SecretRegistry;
  /** Renders the effective config as YAML with every secret scrubbed. Always re-parses cleanly. */
  redactedDump(): string;
}

const FALLBACK_LOCATION: SourceLocation = {
  file: '(unknown)',
  range: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } },
};

const SECTION_TO_KIND: Readonly<Record<(typeof COMPONENT_SECTION_KEYS)[number], ComponentKind>> = {
  sources: 'source',
  transforms: 'transform',
  sinks: 'sink',
};

/** Loads and validates a pipeline config from one file, several files, or a directory. */
export async function loadConfig(
  inputs: string | readonly string[],
  options: LoadConfigOptions,
): Promise<LoadedConfig> {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const files = await expandInputs(list);
  if (files.length === 0) {
    throw new FerruleError('E_CONFIG_NO_FILES', 'no config files were found');
  }

  const env = options.env ?? process.env;
  const secrets = new SecretRegistry();
  const interpCtx: InterpolationContext = {
    env,
    secrets,
    ...(options.secretBackend !== undefined ? { secretBackend: options.secretBackend } : {}),
  };

  const diagnostics: ConfigDiagnostic[] = [];
  const sourceTexts = new Map<string, string>();
  const perFile: { file: string; value: unknown; positions: PositionMap }[] = [];

  for (const file of files) {
    const text = await readFileOrThrow(file);
    sourceTexts.set(file, text);
    let root;
    try {
      root = isJsonFile(file) ? readJsonDocument(text) : parseYamlDocument(text);
    } catch (error) {
      diagnostics.push(parseErrorToDiagnostic(file, error));
      continue;
    }
    if (root.kind !== 'mapping') {
      diagnostics.push({
        file,
        range: root.range,
        message: 'the top level of a config file must be a mapping',
        code: 'invalid_type',
      });
      continue;
    }
    const interpolated = await interpolateTree(root, interpCtx);
    const { value, positions } = nodeToPlain(interpolated, file);
    perFile.push({ file, value, positions });
  }

  if (diagnostics.length > 0) throw new ConfigError(diagnostics, sourceTexts);

  const positions = new PositionMap();
  for (const entry of perFile) positions.merge(entry.positions);

  const merged = mergeDocuments(perFile, diagnostics);
  if (diagnostics.length > 0) throw new ConfigError(diagnostics, sourceTexts);

  const ctx = new ParseContext();
  for (const key of Object.keys(merged.global)) {
    if (!(GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key)) {
      const suggestion = closestMatch(key, TOP_LEVEL_KEYS);
      ctx.at(key, () =>
        ctx.report(
          'unknown_key',
          'is not a recognised top-level key',
          suggestion === undefined ? undefined : `did you mean "${suggestion}"?`,
        ),
      );
    }
  }
  const filteredGlobal: Record<string, unknown> = {};
  for (const key of GLOBAL_SETTINGS_KEYS) {
    if (Object.hasOwn(merged.global, key)) defineField(filteredGlobal, key, merged.global[key]);
  }
  const globalResult = globalSettingsSchema.safeParse(filteredGlobal);
  if (!globalResult.ok) ctx.issues.push(...globalResult.issues);

  const components: LoadedComponent[] = [];
  for (const section of COMPONENT_SECTION_KEYS) {
    const kind = SECTION_TO_KIND[section];
    ctx.at(section, () => {
      for (const [id, raw] of merged.sections[section]) {
        ctx.at(id, () => {
          if (!COMPONENT_ID.test(id)) {
            ctx.report(
              'invalid_string',
              'must be a component ID (lowercase letters, digits, "_" or "-", starting with a letter)',
            );
            return;
          }
          const result = validateComponentEntry(raw, kind, options.registry, ctx);
          if (result === invalid) return;
          const location = positions.resolve([section, id]) ?? FALLBACK_LOCATION;
          components.push({
            id,
            kind,
            type: result.type,
            definition: result.definition,
            options: result.options,
            rawOptions: result.rawOptions,
            inputs: result.inputs,
            location,
            ...(result.buffer !== undefined ? { buffer: result.buffer } : {}),
            ...(result.acknowledgements !== undefined
              ? { acknowledgements: result.acknowledgements }
              : {}),
          });
        });
      }
    });
  }

  for (const issue of ctx.issues) diagnostics.push(issueToDiagnostic(issue, positions));
  if (diagnostics.length > 0) throw new ConfigError(diagnostics, sourceTexts);

  const global = globalResult.ok
    ? globalResult.value
    : (filteredGlobal as unknown as GlobalSettings);
  const sourcesMap = new Map(components.filter((c) => c.kind === 'source').map((c) => [c.id, c]));
  const transformsMap = new Map(
    components.filter((c) => c.kind === 'transform').map((c) => [c.id, c]),
  );
  const sinksMap = new Map(components.filter((c) => c.kind === 'sink').map((c) => [c.id, c]));

  return {
    dataDir: global.data_dir,
    acknowledgements: global.acknowledgements,
    log: global.log,
    api: global.api,
    healthchecks: global.healthchecks,
    sources: sourcesMap,
    transforms: transformsMap,
    sinks: sinksMap,
    components,
    secrets,
    redactedDump: () => redactedDump(global, components, secrets),
  };
}

// ---------------------------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------------------------

function isJsonFile(file: string): boolean {
  return /\.json$/i.test(file);
}

async function expandInputs(inputs: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const info = await stat(input).catch((error: unknown) => {
      throw new FerruleError('E_CONFIG_NOT_FOUND', `config path not found: ${input}`, {
        cause: error,
      });
    });
    if (info.isDirectory()) {
      const entries = await readdir(input);
      const matched = entries.filter((e) => /\.(ya?ml|json)$/i.test(e)).sort();
      for (const e of matched) files.push(path.join(input, e));
    } else {
      files.push(input);
    }
  }
  return files;
}

async function readFileOrThrow(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new FerruleError('E_CONFIG_NOT_FOUND', `could not read config file ${file}`, {
      cause: error,
    });
  }
}

function parseErrorToDiagnostic(file: string, error: unknown): ConfigDiagnostic {
  if (error instanceof ParseError && hasLineColumn(error)) {
    return {
      file,
      range: {
        start: { offset: error.offset ?? 0, line: error.line, column: error.column },
        end: { offset: error.offset ?? 0, line: error.line, column: error.column },
      },
      message: error.message,
      code: error.code,
    };
  }
  if (error instanceof FerruleError) {
    return { file, range: undefined, message: error.message, code: error.code };
  }
  throw error;
}

function hasLineColumn(error: unknown): error is { line: number; column: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { line?: unknown }).line === 'number' &&
    typeof (error as { column?: unknown }).column === 'number'
  );
}

// ---------------------------------------------------------------------------------------------
// Multi-file merging
// ---------------------------------------------------------------------------------------------

interface MergedDocuments {
  readonly global: Record<string, unknown>;
  readonly sections: Readonly<
    Record<(typeof COMPONENT_SECTION_KEYS)[number], Map<string, unknown>>
  >;
}

function mergeDocuments(
  perFile: readonly { file: string; value: unknown }[],
  diagnostics: ConfigDiagnostic[],
): MergedDocuments {
  const global: Record<string, unknown> = {};
  const globalOrigin = new Map<string, string>();
  const sections: Record<(typeof COMPONENT_SECTION_KEYS)[number], Map<string, unknown>> = {
    sources: new Map(),
    transforms: new Map(),
    sinks: new Map(),
  };
  const componentOrigin = new Map<string, { file: string; section: string }>();

  for (const { file, value } of perFile) {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (isSectionKey(key)) {
        const sectionValue = obj[key];
        if (
          typeof sectionValue !== 'object' ||
          sectionValue === null ||
          Array.isArray(sectionValue)
        ) {
          diagnostics.push({
            file,
            range: undefined,
            message: `${key} must be a mapping of component IDs`,
            code: 'invalid_type',
          });
          continue;
        }
        const bucket = sections[key];
        const sectionRecord = sectionValue as Record<string, unknown>;
        for (const id of Object.keys(sectionRecord)) {
          const existing = componentOrigin.get(id);
          if (existing !== undefined) {
            diagnostics.push({
              file,
              range: undefined,
              message: `component id ${JSON.stringify(id)} is already defined in ${existing.file} (as ${existing.section})`,
              code: 'custom',
            });
            continue;
          }
          componentOrigin.set(id, { file, section: key });
          bucket.set(id, sectionRecord[id]);
        }
      } else {
        const existing = globalOrigin.get(key);
        if (existing !== undefined) {
          diagnostics.push({
            file,
            range: undefined,
            message: `key ${JSON.stringify(key)} is already defined in ${existing}`,
            code: 'custom',
          });
          continue;
        }
        globalOrigin.set(key, file);
        defineField(global, key, obj[key]);
      }
    }
  }
  return { global, sections };
}

function isSectionKey(key: string): key is (typeof COMPONENT_SECTION_KEYS)[number] {
  return (COMPONENT_SECTION_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------------------------
// Redacted dump
// ---------------------------------------------------------------------------------------------

function redactedDump(
  global: GlobalSettings,
  components: readonly LoadedComponent[],
  secrets: SecretRegistry,
): string {
  const effective: Record<string, unknown> = {};
  if (global.data_dir !== undefined) defineField(effective, 'data_dir', global.data_dir);
  defineField(effective, 'acknowledgements', global.acknowledgements);
  defineField(effective, 'log', global.log);
  defineField(effective, 'api', global.api);
  defineField(effective, 'healthchecks', global.healthchecks);

  for (const section of COMPONENT_SECTION_KEYS) {
    const kind = SECTION_TO_KIND[section];
    const bucket: Record<string, unknown> = {};
    for (const c of components) {
      if (c.kind !== kind) continue;
      const entry: Record<string, unknown> = { type: c.type };
      if (c.inputs.length > 0) {
        defineField(
          entry,
          'inputs',
          c.inputs.map((r) => (r.port === undefined ? r.id : `${r.id}.${r.port}`)),
        );
      }
      if (c.buffer !== undefined) defineField(entry, 'buffer', bufferSchema.redact(c.buffer));
      if (c.acknowledgements !== undefined) {
        defineField(entry, 'acknowledgements', c.acknowledgements);
      }
      const redactedOptions = c.definition.options.redact(c.rawOptions);
      if (isRecord(redactedOptions)) {
        for (const key of Object.keys(redactedOptions)) {
          defineField(entry, key, redactedOptions[key]);
        }
      }
      defineField(bucket, c.id, entry);
    }
    defineField(effective, section, bucket);
  }

  return secrets.redact(emitYaml(effective));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
