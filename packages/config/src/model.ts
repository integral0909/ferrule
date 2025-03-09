import type { ComponentDefinition, ComponentKind, ComponentRegistry } from '@ferrule/runtime';
import {
  describeInput,
  invalid,
  isPlainObject,
  s,
  type Infer,
  type Issue,
  type ParseContext,
} from '@ferrule/schema';

/**
 * The Ferrule pipeline config model: global settings and the `sources` / `transforms` / `sinks`
 * sections. Global settings are a plain `@ferrule/schema` schema; component entries need a
 * hand-written validator because their shape depends on the (dynamic) {@link ComponentRegistry}.
 */

// ---------------------------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------------------------

const logSchema = s.object({
  level: s.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  format: s.enum(['text', 'json']).default('text'),
});

const apiSchema = s.object({
  enabled: s.boolean().default(false),
  address: s.socketAddress().optional(),
});

const healthchecksSchema = s.object({
  enabled: s.boolean().default(true),
  timeout: s.duration().default(5000),
});

export const globalSettingsSchema = s.object({
  data_dir: s.string().optional(),
  acknowledgements: s.boolean().default(false),
  log: logSchema.default({ level: 'info', format: 'text' }),
  api: apiSchema.default({ enabled: false }),
  healthchecks: healthchecksSchema.default({ enabled: true, timeout: 5000 }),
});

export type GlobalSettings = Infer<typeof globalSettingsSchema>;

/** The top-level keys a config file may define. Used to reject unknown keys with a suggestion. */
export const GLOBAL_SETTINGS_KEYS = [
  'data_dir',
  'acknowledgements',
  'log',
  'api',
  'healthchecks',
] as const;
export const COMPONENT_SECTION_KEYS = ['sources', 'transforms', 'sinks'] as const;
export const TOP_LEVEL_KEYS = [...GLOBAL_SETTINGS_KEYS, ...COMPONENT_SECTION_KEYS] as const;

// ---------------------------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------------------------

const memoryBufferSchema = s.object({
  max_events: s.integer({ min: 1 }).optional(),
});

const diskBufferSchema = s.object({
  max_size: s.byteSize().optional(),
  when_full: s.enum(['block', 'drop_newest']).default('block'),
});

export const bufferSchema = s.tagged('type', {
  memory: memoryBufferSchema,
  disk: diskBufferSchema,
});

export type BufferConfig = Infer<typeof bufferSchema>;

// ---------------------------------------------------------------------------------------------
// Component entries
// ---------------------------------------------------------------------------------------------

/** A parsed `id` or `id.port` entry in a component's `inputs`. */
export interface ComponentInputRef {
  readonly id: string;
  readonly port?: string;
}

const INPUT_REF_PATTERN = /^([a-z][a-z0-9_-]{0,127})(?:\.([a-z][a-z0-9_-]{0,127}))?$/;

export function parseInputRef(text: string): ComponentInputRef | undefined {
  const m = INPUT_REF_PATTERN.exec(text);
  if (m === null) return undefined;
  const id = m[1]!;
  const port = m[2];
  return port === undefined ? { id } : { id, port };
}

const RESERVED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'type',
  'inputs',
  'buffer',
  'acknowledgements',
]);

/** The result of validating one component's raw config entry against its registry definition. */
export interface ComponentEntryResult {
  readonly type: string;
  readonly definition: ComponentDefinition;
  readonly inputs: readonly ComponentInputRef[];
  readonly buffer?: BufferConfig;
  readonly acknowledgements?: boolean;
  readonly rawOptions: unknown;
  readonly options: unknown;
}

/**
 * Validates one entry of a `sources` / `transforms` / `sinks` map: the envelope fields (`type`,
 * `inputs`, `buffer`, `acknowledgements`) plus, once `type` resolves to a registry definition,
 * the component-specific options against that definition's schema. Reports every issue found
 * (never stops at the first) via `ctx`, whose current path must already be at this component.
 */
export function validateComponentEntry(
  raw: unknown,
  kind: ComponentKind,
  registry: ComponentRegistry,
  ctx: ParseContext,
): ComponentEntryResult | typeof invalid {
  if (!isPlainObject(raw)) {
    ctx.report('invalid_type', `expected an object, got ${describeInput(raw)}`);
    return invalid;
  }

  let failed = false;
  let definition: ComponentDefinition | undefined;
  const typeRaw = raw['type'];
  if (typeof typeRaw !== 'string') {
    ctx.at('type', () => ctx.report('required', 'is required'));
    failed = true;
  } else {
    try {
      definition = registry.get(kind, typeRaw);
    } catch (error) {
      ctx.at('type', () =>
        ctx.report('custom', error instanceof Error ? error.message : String(error)),
      );
      failed = true;
    }
  }

  const inputs: ComponentInputRef[] = [];
  if (kind === 'source') {
    if (raw['inputs'] !== undefined) {
      ctx.at('inputs', () => ctx.report('custom', 'sources do not accept inputs'));
      failed = true;
    }
  } else {
    const inputsRaw = raw['inputs'];
    if (inputsRaw === undefined) {
      ctx.at('inputs', () => ctx.report('required', 'is required'));
      failed = true;
    } else {
      const list = Array.isArray(inputsRaw) ? inputsRaw : [inputsRaw];
      if (list.length === 0) {
        ctx.at('inputs', () => ctx.report('too_small', 'must not be empty'));
        failed = true;
      }
      ctx.at('inputs', () => {
        list.forEach((item, i) => {
          if (typeof item !== 'string') {
            ctx.at(i, () =>
              ctx.report('invalid_type', `expected a string, got ${describeInput(item)}`),
            );
            failed = true;
            return;
          }
          const ref = parseInputRef(item);
          if (ref === undefined) {
            ctx.at(i, () =>
              ctx.report(
                'invalid_format',
                `invalid input reference ${JSON.stringify(item)}; expected "id" or "id.port"`,
              ),
            );
            failed = true;
            return;
          }
          inputs.push(ref);
        });
      });
    }
  }

  let buffer: BufferConfig | undefined;
  if (raw['buffer'] !== undefined) {
    if (kind !== 'sink') {
      ctx.at('buffer', () => ctx.report('custom', `${kind}s do not accept a buffer`));
      failed = true;
    } else {
      const result = bufferSchema.safeParse(raw['buffer']);
      if (!result.ok) {
        pushNested(ctx, 'buffer', result.issues);
        failed = true;
      } else {
        buffer = result.value;
      }
    }
  }

  let acknowledgements: boolean | undefined;
  if (raw['acknowledgements'] !== undefined) {
    const result = s.boolean().safeParse(raw['acknowledgements']);
    if (!result.ok) {
      pushNested(ctx, 'acknowledgements', result.issues);
      failed = true;
    } else {
      acknowledgements = result.value;
    }
  }

  const rawOptions: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!RESERVED_ENTRY_KEYS.has(key)) defineOwn(rawOptions, key, raw[key]);
  }

  let options: unknown;
  if (definition !== undefined) {
    const result = definition.options.safeParse(rawOptions);
    if (!result.ok) {
      pushNested(ctx, undefined, result.issues);
      failed = true;
    } else {
      options = result.value;
    }
  }

  if (failed || definition === undefined) return invalid;
  return {
    type: typeRaw as string,
    definition,
    inputs,
    rawOptions,
    options,
    ...(buffer !== undefined ? { buffer } : {}),
    ...(acknowledgements !== undefined ? { acknowledgements } : {}),
  };
}

function pushNested(
  ctx: ParseContext,
  prefixKey: string | undefined,
  issues: readonly Issue[],
): void {
  const base = prefixKey === undefined ? ctx.currentPath : [...ctx.currentPath, prefixKey];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    const out: Issue = { path, code: issue.code, message: issue.message };
    if (issue.hint !== undefined) out.hint = issue.hint;
    ctx.issues.push(out);
  }
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
