/**
 * `ferrule explain <code>` first checks Ferrule Script's own diagnostic catalog
 * (`@ferrule/script`'s `explainCode`); this is the catalog for everything else a pipeline can
 * fail to validate on: topology-graph codes (from `@ferrule/runtime`'s `buildTopology`) and the
 * generic schema/config issue codes used throughout `@ferrule/schema` and `@ferrule/config`.
 */
export interface CatalogEntry {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly summary: string;
  readonly explanation: string;
}

function entry(
  code: string,
  severity: 'error' | 'warning',
  summary: string,
  explanation: string,
): CatalogEntry {
  return { code, severity, summary, explanation };
}

export const TOPOLOGY_CATALOG: readonly CatalogEntry[] = [
  entry(
    'E_DUPLICATE_ID',
    'error',
    'duplicate component ID',
    'The same component ID is used more than once across sources, transforms, and sinks. Component IDs must be unique across all three sections.',
  ),
  entry(
    'E_UNKNOWN_COMPONENT_TYPE',
    'error',
    'unknown component type',
    "A component's `type` is not registered. Run `ferrule list` to see every available source, transform, and sink type.",
  ),
  entry(
    'E_SCHEMA',
    'error',
    'invalid component options',
    "A component's options failed its schema. Run `ferrule describe <type>` to see the option schema, including defaults and required fields.",
  ),
  entry(
    'E_UNKNOWN_INPUT',
    'error',
    'unknown input reference',
    'An `inputs` entry names a component ID that does not exist in this pipeline.',
  ),
  entry(
    'E_SINK_AS_INPUT',
    'error',
    'sink used as an input',
    'An `inputs` entry names a sink. Sinks have no outputs and cannot feed another component.',
  ),
  entry(
    'E_UNKNOWN_PORT',
    'error',
    'unknown output port',
    'An `inputs` entry names a port (`id.port`) the producing component never declares. Most components only have the default port.',
  ),
  entry(
    'E_CYCLE',
    'error',
    'cycle in pipeline graph',
    'The pipeline graph has a cycle: some component is (directly or transitively) its own input. Pipelines must be a DAG.',
  ),
  entry(
    'E_EVENT_KIND_MISMATCH',
    'error',
    'event kind mismatch',
    'A transform or sink does not accept any of the event kinds (log/metric/span) its inputs produce.',
  ),
  entry(
    'E_NO_INPUTS',
    'error',
    'component has no inputs',
    'A transform or sink declares an empty `inputs` list. Every transform and sink needs at least one input.',
  ),
  entry(
    'E_COMPONENT_BUILD_FAILED',
    'error',
    'component failed to build',
    "A component's `build()` threw while constructing it (for example, a script that fails to compile, or a file path that cannot be created). The message names the underlying cause.",
  ),
  entry(
    'W_UNUSED_SOURCE',
    'warning',
    'unused source',
    'A source is never referenced as an input by any transform or sink, so nothing it produces is ever delivered anywhere.',
  ),
];

export const SCHEMA_CATALOG: readonly CatalogEntry[] = [
  entry(
    'invalid_type',
    'error',
    'wrong value type',
    'A value has the wrong JSON/YAML type for this field (for example a string where a number was expected).',
  ),
  entry('required', 'error', 'missing required field', 'A required field was not given.'),
  entry(
    'unknown_key',
    'error',
    'unknown field',
    'A field is not recognised by this schema. Check for a typo; the message includes a suggestion when one is close.',
  ),
  entry(
    'too_small',
    'error',
    'value too small',
    'A number, string, or array is below its minimum (length, count, or value).',
  ),
  entry(
    'too_big',
    'error',
    'value too big',
    'A number, string, or array is above its maximum (length, count, or value).',
  ),
  entry(
    'invalid_string',
    'error',
    'invalid string',
    'A string does not match the required pattern or form.',
  ),
  entry(
    'invalid_enum',
    'error',
    'invalid choice',
    'A value is not one of the allowed choices for this field.',
  ),
  entry(
    'invalid_union',
    'error',
    'no matching variant',
    'A value does not match any of the accepted shapes for this field.',
  ),
  entry(
    'invalid_format',
    'error',
    'invalid format',
    'A value could not be parsed in its expected format (a duration, byte size, URL, address, ...).',
  ),
  entry(
    'custom',
    'error',
    'invalid value',
    'A field failed a check specific to that option; the message explains the constraint.',
  ),
];

export const CONFIG_CATALOG: readonly CatalogEntry[] = [
  entry(
    'E_CONFIG',
    'error',
    'invalid configuration',
    'One or more configuration issues were found; see the accompanying diagnostics for details.',
  ),
  entry(
    'E_CONFIG_NOT_FOUND',
    'error',
    'config path not found',
    'A path given to `-c/--config` does not exist.',
  ),
  entry(
    'E_CONFIG_NO_FILES',
    'error',
    'no config files found',
    'None of the given paths resolved to any `.yaml`/`.yml`/`.json` files.',
  ),
  entry(
    'E_CONFIG_SECRET_NAME',
    'error',
    'invalid secret name',
    'A `${secret:NAME}` reference uses a name the active secret backend rejects.',
  ),
  entry(
    'E_CONFIG_SECRET_PATH',
    'error',
    'secret escapes secrets directory',
    'A `${secret:NAME}` reference with `--secrets-dir` would read outside the configured directory.',
  ),
  entry(
    'E_CONFIG_INTERPOLATION',
    'error',
    'interpolation error',
    'A `${...}` substitution failed: an undefined required environment variable, or `${secret:...}` with no secret backend configured.',
  ),
];

const ALL: ReadonlyMap<string, CatalogEntry> = new Map(
  [...TOPOLOGY_CATALOG, ...SCHEMA_CATALOG, ...CONFIG_CATALOG].map((e) => [e.code, e]),
);

export function explainCliCode(code: string): CatalogEntry | undefined {
  return ALL.get(code);
}

export function allCliCatalogEntries(): readonly CatalogEntry[] {
  return [...ALL.values()];
}
