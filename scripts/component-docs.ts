/**
 * Renders `docs/reference/components.md` from every builtin component definition's own schema
 * — descriptions, accepted/produced event kinds, output ports, an options table (from
 * `Schema.toDoc()`), and each example config as YAML. Pure and side-effect-free (no filesystem
 * access) so it can be exercised directly; `generate-component-docs.ts` is the runnable script
 * that loads the real builtin definitions and writes (or, with `--check`, verifies) the file.
 */
import { DEFAULT_PORT } from '../packages/runtime/dist/index.js';
import type {
  ComponentDefinition,
  OutputPort,
  SinkDefinition,
  SourceDefinition,
  TransformDefinition,
} from '../packages/runtime/dist/index.js';
import { emitYaml } from '../packages/config/dist/index.js';
import type { SchemaDoc } from '../packages/schema/dist/index.js';

// -------------------------------------------------------------------------------------------
// Options table
// -------------------------------------------------------------------------------------------

interface FieldRow {
  readonly path: string;
  readonly doc: SchemaDoc;
}

/** Flattens an object/array `SchemaDoc` tree into one row per leaf-or-branch field, dotted-path
 * named (`multiline.timeoutMs`) with `[]` for array items (`routes[].condition`). */
function flattenFields(doc: SchemaDoc, prefix: string, out: FieldRow[]): void {
  if (doc.fields !== undefined) {
    for (const [key, field] of Object.entries(doc.fields)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      out.push({ path, doc: field });
      flattenFields(field, path, out);
    }
    return;
  }
  if (doc.items !== undefined) flattenFields(doc.items, `${prefix}[]`, out);
}

function describeType(doc: SchemaDoc): string {
  switch (doc.type) {
    case 'enum':
      return doc.values !== undefined
        ? `enum(${doc.values.map((v) => JSON.stringify(v)).join(', ')})`
        : 'enum';
    case 'literal':
      return doc.values !== undefined && doc.values.length > 0
        ? JSON.stringify(doc.values[0])
        : 'literal';
    case 'array':
      return doc.items !== undefined ? `${describeType(doc.items)}[]` : 'array';
    case 'record':
      return doc.items !== undefined ? `record<string, ${describeType(doc.items)}>` : 'record';
    case 'union':
      return doc.variants !== undefined && doc.variants.length > 0
        ? doc.variants.map((v) => describeType(v)).join(' \\| ')
        : 'union';
    default:
      return doc.type;
  }
}

/** `JSON.stringify` that doesn't throw on a `bigint` (some options accept large integers). */
function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderOptionsTable(optionsDoc: SchemaDoc): string {
  const rows: FieldRow[] = [];
  flattenFields(optionsDoc, '', rows);
  if (rows.length === 0) return '_No options._';
  const lines = [
    '| Option | Type | Default | Required | Secret | Description | Constraints |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { path, doc } of rows) {
    const required = doc.optional !== true;
    const def = doc.default !== undefined ? `\`${escapeCell(jsonSafe(doc.default))}\`` : '';
    const secret = doc.secret === true ? 'yes' : '';
    const description = doc.description !== undefined ? escapeCell(doc.description) : '';
    const constraints =
      doc.constraints !== undefined && Object.keys(doc.constraints).length > 0
        ? escapeCell(
            Object.entries(doc.constraints)
              .map(([k, v]) => `${k}=${jsonSafe(v)}`)
              .join(', '),
          )
        : '';
    lines.push(
      `| \`${path}\` | ${describeType(doc)} | ${def} | ${required ? 'yes' : 'no'} | ${secret} | ` +
        `${description} | ${constraints} |`,
    );
  }
  return lines.join('\n');
}

// -------------------------------------------------------------------------------------------
// Ports, kinds, examples
// -------------------------------------------------------------------------------------------

function renderPorts(extra: readonly OutputPort[]): string {
  const lines = [`- \`${DEFAULT_PORT}\` — the default port`];
  for (const port of extra) lines.push(`- \`${port.name}\` — ${port.description}`);
  return lines.join('\n');
}

/** A representative validated options value, used only to call `produces`/`outputs` (which take
 * options as a parameter) for documentation purposes — never to build or run the component. */
function sampleOptions(definition: ComponentDefinition): unknown {
  const example = definition.examples?.[0];
  if (example !== undefined) {
    const parsed = definition.options.safeParse(example.config);
    if (parsed.ok) return parsed.value;
  }
  const empty = definition.options.safeParse({});
  return empty.ok ? empty.value : undefined;
}

function renderExamples(definition: ComponentDefinition): string {
  const examples = definition.examples ?? [];
  if (examples.length === 0) return '_No examples._';
  return examples
    .map((example) => {
      const yaml = emitYaml({ type: definition.type, ...example.config }).trimEnd();
      return `**${example.title}**\n\n\`\`\`yaml\n${yaml}\n\`\`\``;
    })
    .join('\n\n');
}

// -------------------------------------------------------------------------------------------
// Per-component / per-section / full-page rendering
// -------------------------------------------------------------------------------------------

function renderComponent(definition: ComponentDefinition): string {
  const lines: string[] = [`## \`${definition.type}\``, '', definition.description, ''];
  const sample = sampleOptions(definition);

  if (definition.kind === 'transform' || definition.kind === 'sink') {
    lines.push(`**Accepts:** ${definition.accepts.join(', ') || '_nothing_'}`, '');
  }
  if (definition.kind === 'source') {
    const produced = sample === undefined ? [] : definition.produces(sample);
    lines.push(`**Produces:** ${produced.join(', ') || '_nothing_'}`, '');
  } else if (definition.kind === 'transform') {
    const produced =
      sample === undefined
        ? definition.accepts
        : (definition.produces?.(sample, definition.accepts) ?? definition.accepts);
    lines.push(`**Produces:** ${produced.join(', ') || '_nothing_'}`, '');
  }

  if (definition.kind === 'source' || definition.kind === 'transform') {
    const ports = sample === undefined ? [] : (definition.outputs?.(sample) ?? []);
    lines.push('**Output ports:**', '', renderPorts(ports), '');
  }

  lines.push('**Options:**', '', renderOptionsTable(definition.options.toDoc()), '');
  lines.push('**Examples:**', '', renderExamples(definition));
  return lines.join('\n');
}

function renderSection(title: string, definitions: readonly ComponentDefinition[]): string {
  const sorted = [...definitions].sort((a, b) => a.type.localeCompare(b.type));
  return [`# ${title}`, ...sorted.map((d) => renderComponent(d))].join('\n\n');
}

/** Renders the full `docs/reference/components.md` page. */
export function renderComponentsDoc(
  sources: readonly SourceDefinition[],
  operators: readonly TransformDefinition[],
  sinks: readonly SinkDefinition[],
): string {
  const header = [
    '# Component reference',
    '',
    'Generated by `scripts/generate-component-docs.ts` from every builtin component ' +
      "definition's own schema (`@ferrule/sources`, `@ferrule/operators`, `@ferrule/sinks`). " +
      'Do not edit by hand: run `pnpm run docs:generate` to regenerate it, and ' +
      '`pnpm run docs:check` (run in CI) to verify it is up to date.',
  ].join('\n');
  const body = [
    renderSection('Sources', sources),
    renderSection('Operators', operators),
    renderSection('Sinks', sinks),
  ].join('\n\n');
  return `${header}\n\n${body}\n`;
}
