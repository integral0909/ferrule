import type { ComponentDefinition, ComponentKind } from '@ferrule/runtime';
import { closestMatch } from '@ferrule/schema';
import type { SchemaDoc } from '@ferrule/schema';
import { withGlobalFlags } from '../args.js';
import { buildDefaultRegistry } from '../registry.js';
import { EXIT_OK } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { writeLine } from '../output.js';
import { Painter } from '../color.js';
import type { Command } from '../command.js';

const ALL_KINDS: readonly ComponentKind[] = ['source', 'transform', 'sink'];

function typeLabel(doc: SchemaDoc): string {
  switch (doc.type) {
    case 'tagged_union':
      return `tagged union (on \`${doc.discriminator}\`)`;
    case 'union':
      return 'one of';
    case 'record':
      return 'map';
    case 'field_path':
      return 'field path';
    case 'byte_size':
      return 'byte size';
    case 'socket_address':
      return 'address';
    default:
      return doc.type;
  }
}

function renderDoc(
  paint: Painter,
  name: string,
  doc: SchemaDoc,
  indent: number,
  lines: string[],
): void {
  const pad = '  '.repeat(indent);
  const markers: string[] = [];
  if (doc.secret === true) markers.push(paint.yellow('secret'));
  if (doc.optional === true && doc.default === undefined) markers.push('optional');
  if (doc.deprecated !== undefined) markers.push(paint.red(`deprecated: ${doc.deprecated}`));
  const defaultText = doc.default !== undefined ? ` = ${describeDefault(doc.default)}` : '';
  const markerText = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
  const description = doc.description !== undefined ? ` — ${doc.description}` : '';
  lines.push(
    `${pad}${paint.cyan(name)}: ${paint.dim(typeLabel(doc))}${defaultText}${markerText}${description}`,
  );
  if (doc.constraints !== undefined) {
    const parts = Object.entries(doc.constraints).map(([k, v]) => `${k}=${describeDefault(v)}`);
    if (parts.length > 0) lines.push(`${pad}  ${paint.dim(`(${parts.join(', ')})`)}`);
  }
  if (doc.values !== undefined && doc.type !== 'tagged_union') {
    lines.push(`${pad}  ${paint.dim(`values: ${doc.values.map(describeDefault).join(', ')}`)}`);
  }
  if (doc.fields !== undefined) {
    for (const [key, field] of Object.entries(doc.fields)) {
      renderDoc(paint, key, field, indent + 1, lines);
    }
  }
  if (doc.items !== undefined) renderDoc(paint, '[item]', doc.items, indent + 1, lines);
  if (doc.variants !== undefined) {
    doc.variants.forEach((variant, i) => {
      const label =
        doc.discriminator !== undefined && variant.values !== undefined
          ? `${doc.discriminator} = ${JSON.stringify(variant.values[0])}`
          : `variant ${i + 1}`;
      renderDoc(paint, label, variant, indent + 1, lines);
    });
  }
  if (doc.examples !== undefined && doc.examples.length > 0) {
    for (const example of doc.examples) {
      lines.push(`${pad}  ${paint.dim(`example: ${describeDefault(example)}`)}`);
    }
  }
}

function describeDefault(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}

function findDefinition(
  type: string,
  registryLookup: (kind: ComponentKind, type: string) => ComponentDefinition | undefined,
): { kind: ComponentKind; definition: ComponentDefinition }[] {
  const matches: { kind: ComponentKind; definition: ComponentDefinition }[] = [];
  for (const kind of ALL_KINDS) {
    const definition = registryLookup(kind, type);
    if (definition !== undefined) matches.push({ kind, definition });
  }
  return matches;
}

export const describeCommand: Command = {
  spec: withGlobalFlags({
    name: 'describe',
    summary: 'Show the option schema for a source, transform, or sink type.',
    usage: 'ferrule describe <type> [options]',
    flags: [{ name: 'json', type: 'boolean', description: 'Print the schema as JSON.' }],
    positionals: [
      { name: 'type', description: 'The component type, e.g. `http_server`.', required: true },
    ],
    examples: ['ferrule describe clickhouse', 'ferrule describe demo_logs --json'],
  }),

  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the Command.run contract async uniformly
  async run(ctx, args) {
    const type = args.positionals[0];
    if (type === undefined) throw new UsageError('missing required argument <type>');
    const registry = buildDefaultRegistry();
    const matches = findDefinition(type, (kind, t) =>
      registry.has(kind, t) ? registry.get(kind, t) : undefined,
    );

    if (matches.length === 0) {
      const everyType = ALL_KINDS.flatMap((kind) => registry.list(kind).map((d) => d.type));
      const suggestion = closestMatch(type, everyType);
      throw new UsageError(
        `unknown component type ${JSON.stringify(type)}` +
          (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
      );
    }

    if (args.flags.get('json') === true) {
      const out = matches.map(({ kind, definition }) => ({
        kind,
        type: definition.type,
        description: definition.description,
        options: definition.options.toDoc(),
        examples: definition.examples ?? [],
      }));
      writeLine(ctx.env.stdout, JSON.stringify(out, null, 2));
      return EXIT_OK;
    }

    const paint = new Painter(ctx.color);
    for (const { kind, definition } of matches) {
      writeLine(ctx.env.stdout, `${paint.bold(definition.type)} ${paint.dim(`(${kind})`)}`);
      writeLine(ctx.env.stdout, definition.description);
      writeLine(ctx.env.stdout);
      const doc = definition.options.toDoc();
      const lines: string[] = [];
      if (doc.fields !== undefined && Object.keys(doc.fields).length > 0) {
        for (const [key, field] of Object.entries(doc.fields)) {
          renderDoc(paint, key, field, 0, lines);
        }
      } else {
        lines.push(paint.dim('(no options)'));
      }
      for (const line of lines) writeLine(ctx.env.stdout, line);
      if (definition.examples !== undefined && definition.examples.length > 0) {
        writeLine(ctx.env.stdout);
        writeLine(ctx.env.stdout, paint.bold('Examples:'));
        for (const example of definition.examples) {
          writeLine(ctx.env.stdout, `  ${example.title}:`);
          writeLine(ctx.env.stdout, `    ${JSON.stringify(example.config)}`);
        }
      }
      writeLine(ctx.env.stdout);
    }
    return EXIT_OK;
  },
};
