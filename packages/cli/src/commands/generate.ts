import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { emitYaml } from '@ferrule/config';
import type { ComponentDefinition, ComponentKind } from '@ferrule/runtime';
import type { SchemaDoc } from '@ferrule/schema';
import { withGlobalFlags } from '../args.js';
import { buildDefaultRegistry } from '../registry.js';
import { EXIT_OK } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { write, writeLine } from '../output.js';
import type { Command } from '../command.js';

const MAX_STUB_DEPTH = 8;

/** A representative placeholder value for a required field, derived from its schema shape. */
function stubValue(doc: SchemaDoc, depth: number): unknown {
  if (depth > MAX_STUB_DEPTH) return null;
  switch (doc.type) {
    case 'string':
      return typeof doc.examples?.[0] === 'string' ? doc.examples[0] : 'CHANGE_ME';
    case 'integer':
    case 'number': {
      const min = doc.constraints?.['min'];
      return typeof min === 'number' ? min : 0;
    }
    case 'boolean':
      return false;
    case 'duration':
      return '30s';
    case 'byte_size':
      return '10MiB';
    case 'socket_address':
      return '0.0.0.0:8080';
    case 'url':
      return 'https://example.invalid';
    case 'field_path':
      return '.field';
    case 'regex':
      return '.*';
    case 'enum':
    case 'literal':
      return doc.values?.[0] ?? null;
    case 'array':
      return doc.constraints?.['minItems'] !== undefined && doc.items !== undefined
        ? [stubValue(doc.items, depth + 1)]
        : [];
    case 'record':
      return {};
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(doc.fields ?? {})) {
        if (field.optional === true) continue;
        out[key] = stubValue(field, depth + 1);
      }
      return out;
    }
    case 'union':
      return doc.variants !== undefined && doc.variants.length > 0
        ? stubValue(doc.variants[0]!, depth + 1)
        : null;
    case 'tagged_union': {
      const variant = doc.variants?.[0];
      if (variant === undefined) return {};
      const value = stubValue(variant, depth + 1) as Record<string, unknown>;
      return { [doc.discriminator ?? 'type']: variant.values?.[0], ...value };
    }
    case 'lazy':
      return {};
    default:
      return null;
  }
}

function stubOptions(definition: ComponentDefinition): Record<string, unknown> {
  const doc = definition.options.toDoc();
  const stub = stubValue(doc, 0);
  return typeof stub === 'object' && stub !== null && !Array.isArray(stub)
    ? (stub as Record<string, unknown>)
    : {};
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  const id = `${base}_${i}`;
  used.add(id);
  return id;
}

export const generateCommand: Command = {
  spec: withGlobalFlags({
    name: 'generate',
    summary: 'Scaffold a starter pipeline config from a chain of component types.',
    usage: 'ferrule generate <source>/<transform...>/<sink> [options]',
    flags: [
      {
        name: 'output',
        short: 'o',
        type: 'path',
        description: 'Write to a file instead of stdout.',
      },
    ],
    positionals: [
      {
        name: 'chain',
        description:
          'Component types, source first and sink last, joined with `/` or given as separate arguments.',
        variadic: true,
        required: true,
      },
    ],
    examples: [
      'ferrule generate demo_logs/console',
      'ferrule generate demo_logs remap_fields console',
    ],
  }),

  async run(ctx, args) {
    const registry = buildDefaultRegistry();
    const segments =
      args.positionals.length === 1 && args.positionals[0]!.includes('/')
        ? args.positionals[0]!.split('/')
        : args.positionals;
    if (segments.length < 2) {
      throw new UsageError(
        'need at least a source and a sink, e.g. `ferrule generate demo_logs/console`',
      );
    }

    const sourceType = segments[0]!;
    const sinkType = segments[segments.length - 1]!;
    const transformTypes = segments.slice(1, -1);

    const lookup = (kind: ComponentKind, type: string): ComponentDefinition => {
      if (!registry.has(kind, type)) {
        throw new UsageError(
          `unknown ${kind} type ${JSON.stringify(type)}; run \`ferrule list ${kind}s\` to see what's available`,
        );
      }
      return registry.get(kind, type);
    };

    const used = new Set<string>();
    const sourceDef = lookup('source', sourceType);
    const sourceId = uniqueId(sourceType, used);
    const sources: Record<string, unknown> = {
      [sourceId]: { type: sourceType, ...stubOptions(sourceDef) },
    };

    const transforms: Record<string, unknown> = {};
    let previousId = sourceId;
    for (const type of transformTypes) {
      const def = lookup('transform', type);
      const id = uniqueId(type, used);
      transforms[id] = { type, inputs: [previousId], ...stubOptions(def) };
      previousId = id;
    }

    const sinkDef = lookup('sink', sinkType);
    const sinkId = uniqueId(sinkType, used);
    const sinks: Record<string, unknown> = {
      [sinkId]: { type: sinkType, inputs: [previousId], ...stubOptions(sinkDef) },
    };

    const doc: Record<string, unknown> = { sources };
    if (Object.keys(transforms).length > 0) doc['transforms'] = transforms;
    doc['sinks'] = sinks;

    const yaml = emitYaml(doc);
    const outputPath = args.flags.get('output');
    if (typeof outputPath === 'string') {
      const resolved = isAbsolute(outputPath) ? outputPath : resolve(ctx.env.cwd, outputPath);
      await writeFile(resolved, yaml, 'utf8');
      writeLine(ctx.env.stderr, `wrote ${resolved}`);
    } else {
      write(ctx.env.stdout, yaml);
    }
    return EXIT_OK;
  },
};
