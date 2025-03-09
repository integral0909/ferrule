# `@ferrule/config`

Loads and validates Ferrule pipeline configuration: a hand-written YAML parser and JSON reader
that both track source positions, `${...}` interpolation with pluggable secret backends, schema
validation against a `ComponentRegistry`, diagnostics rendered as code frames, and a config-diff
helper for hot reload.

## Config file format

A config file is a YAML or JSON document whose top level is a mapping with these keys, all
optional except `sources`/`transforms`/`sinks` where at least one component is needed to do
anything useful:

```yaml
data_dir: /var/lib/ferrule

acknowledgements: false

log:
  level: info # trace | debug | info | warn | error
  format: text # text | json

api:
  enabled: false
  address: 0.0.0.0:9090

healthchecks:
  enabled: true
  timeout: 5s

sources:
  app_logs:
    type: http
    address: 0.0.0.0:8080

transforms:
  shape:
    type: script
    inputs: app_logs
    source: |
      .service = .service ?? "unknown"
      del(.debug)

sinks:
  store:
    type: clickhouse
    inputs: [shape]
    endpoint: https://clickhouse.internal:8443
    table: logs
    auth:
      password: ${secret:CLICKHOUSE_PASSWORD}
    buffer:
      type: disk
      max_size: 2GiB
      when_full: block
    acknowledgements: true
```

### `sources`, `transforms`, `sinks`

Each is a mapping from **component ID** (lowercase letters, digits, `_`/`-`, starting with a
letter — see `s.componentId()` in `@ferrule/schema`) to a component entry. IDs must be unique
across all three sections combined. Every entry has:

- `type` (required): the component type, looked up in the `ComponentRegistry` passed to
  `loadConfig`. An unknown type reports every close match as a suggestion.
- `inputs` (required for transforms and sinks; rejected for sources): one string or a list of
  strings, each `id` or `id.port` (for components with named output ports).
- `buffer` (sinks only, optional):
  ```yaml
  buffer:
    type: memory
    max_events: 10000
  # or
  buffer:
    type: disk
    max_size: 1GiB
    when_full: block # or drop_newest
  ```
- `acknowledgements` (optional boolean): overrides the top-level default for this component.
- Everything else is the component's own options, validated against the `Schema` its
  `ComponentDefinition` declares.

### Multi-file and directory configs

`loadConfig` accepts one path, a list of paths, or a directory (in which case every `*.yaml`,
`*.yml`, and `*.json` file in it is loaded, sorted by name). Top-level maps merge: one file can
define `sources`, another `sinks`. It is an error for two files to define the same component ID,
or the same scalar/global key (`data_dir`, `log`, ...) — the error names both files.

### `${...}` interpolation

Every string scalar, in every file, goes through interpolation before validation:

| Form              | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `${VAR}`          | Environment variable `VAR`; empty string if unset.           |
| `${VAR:-default}` | `VAR` if set and non-empty, else the literal text `default`. |
| `${VAR:?message}` | `VAR`, or an error with `message` if unset or empty.         |
| `$$`              | A literal `$` (so `$$FOO` is not interpolated).              |
| `${secret:NAME}`  | Resolved through the configured `SecretBackend`.             |

A substituted value is never re-scanned, so a secret containing `${...}` cannot trigger further
substitution.

Three secret backends are provided: `EnvSecretBackend` (environment variables, optionally under a
prefix), `FileSecretBackend` (a directory with one file per secret, trailing newline trimmed), and
`MapSecretBackend` (an in-memory map, for tests). Exactly one backend is active per `loadConfig`
call. Every resolved secret is added to a `SecretRegistry`, which `redactedDump()` and
`renderDiagnostics()` use to scrub secret values from anything rendered to a person.

### YAML support

The parser covers the subset of YAML 1.2 real pipeline configs use: block and flow
mappings/sequences (including the compact `- key: value` and `- - nested` forms), single- and
double-quoted scalars (with the full common escape set), literal (`|`) and folded (`>`) block
scalars with chomping (`-`/`+`) and explicit indentation indicators, comments, anchors/aliases,
merge keys (`<<`, including a sequence of merge sources), explicit `!!str`/`!!int`/`!!float`/
`!!bool`/`!!null` tags, and a single `---`/`...` document. It resolves plain scalars with the YAML
1.2 **core** schema, not the deprecated 1.1 schema — so `no`, `yes`, `on`, `off` are plain strings,
not booleans (the "Norway problem").

Known simplifications: plain and quoted scalars are single physical lines (use a block scalar for
multi-line text); a bare `key: value` pair directly inside `[...]` without `{...}` is not
supported; YAML directives (`%YAML`, `%TAG`) are rejected with a clear error rather than parsed.

Every parse enforces limits (nesting depth, input length, anchor count, and a cumulative
"alias expansion weight" budget) so a hostile or accidental billion-laughs document fails fast
with a typed `LimitExceededError` instead of exhausting memory.

### Diagnostics

Loading failures raise `ConfigError`, which carries every `ConfigDiagnostic` found (not just the
first) — `loadConfig` validates as much as it can before giving up, so a config with five typos
reports five issues in one run. Each diagnostic has a `file`, a `range` (when known), a `message`,
an optional `hint`, and a stable `code`. `renderDiagnostics(diagnostics, sources)` prints them as
code frames:

```
config.yaml:14:11: error[custom]: sinks.store.type: unknown sink type "clickhous" (did you mean "clickhouse"?)
  13 |   store:
  14 |     type: clickhous
     |           ^^^^^^^^^
```

`ConfigError.sources` already carries the text of every file involved, so callers do not need to
re-read the filesystem just to render the error.

## Programmatic API

```ts
import { loadConfig, EnvSecretBackend } from '@ferrule/config';
import { ComponentRegistry } from '@ferrule/runtime';

const registry = new ComponentRegistry().register(/* ... component definitions ... */);

const config = await loadConfig(['base.yaml', 'overrides.yaml'], {
  registry,
  secretBackend: new EnvSecretBackend('FERRULE_SECRET_'),
});

config.sources; // ReadonlyMap<string, LoadedComponent>
config.redactedDump(); // effective config as YAML, secrets scrubbed
```

`LoadedConfig` also exposes `dataDir`, `acknowledgements`, `log`, `api`, `healthchecks`,
`transforms`, `sinks`, `components` (the flat list), and `secrets` (the `SecretRegistry`).

### Diffing, for hot reload

```ts
import { diffConfigs } from '@ferrule/config';

const diff = diffConfigs(runningConfig, newConfig);
diff.added; // component IDs to start
diff.removed; // component IDs to stop
diff.changed; // component IDs to replace (type, options, inputs, or buffer differ)
diff.unchanged; // component IDs to leave alone
diff.globalChanged; // which of data_dir/acknowledgements/log/api/healthchecks changed
```

## Known gaps

- Multi-line plain and quoted scalars are not supported (use `|`/`>` block scalars instead).
- A bare `key: value` pair directly inside `[...]` (without `{...}`) is not supported.
- YAML directives (`%YAML`, `%TAG`) are rejected rather than interpreted.
- Graph-level checks (do `inputs` reference components that exist, are there cycles) are left to
  the runtime, which has the full topology; `@ferrule/config` validates each component in
  isolation.
- A TOML subset, mentioned as a future option in the architecture doc, is not implemented here.
