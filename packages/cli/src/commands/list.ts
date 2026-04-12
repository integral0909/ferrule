import type { ComponentKind } from '@ferrule/runtime';
import { closestMatch } from '@ferrule/schema';
import { withGlobalFlags } from '../args.js';
import { buildDefaultRegistry } from '../registry.js';
import { EXIT_OK } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { writeLine } from '../output.js';
import { Painter } from '../color.js';
import type { Command } from '../command.js';

const KIND_ALIASES: Readonly<Record<string, ComponentKind>> = {
  source: 'source',
  sources: 'source',
  transform: 'transform',
  transforms: 'transform',
  operator: 'transform',
  operators: 'transform',
  sink: 'sink',
  sinks: 'sink',
};

const ALL_KINDS: readonly ComponentKind[] = ['source', 'transform', 'sink'];
const KIND_LABEL: Readonly<Record<ComponentKind, string>> = {
  source: 'Sources',
  transform: 'Transforms',
  sink: 'Sinks',
};

function resolveKind(arg: string): ComponentKind {
  const kind = KIND_ALIASES[arg.toLowerCase()];
  if (kind === undefined) {
    const suggestion = closestMatch(arg, Object.keys(KIND_ALIASES));
    throw new UsageError(
      `unknown component group ${JSON.stringify(arg)}; expected sources, transforms, or sinks` +
        (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
    );
  }
  return kind;
}

export const listCommand: Command = {
  spec: withGlobalFlags({
    name: 'list',
    summary: 'List available source, transform, and sink types.',
    usage: 'ferrule list [sources|transforms|sinks] [options]',
    flags: [{ name: 'json', type: 'boolean', description: 'Print machine-readable JSON.' }],
    positionals: [
      { name: 'group', description: 'Restrict the listing to sources, transforms, or sinks.' },
    ],
    examples: ['ferrule list', 'ferrule list sinks', 'ferrule list sources --json'],
  }),

  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the Command.run contract async uniformly
  async run(ctx, args) {
    const registry = buildDefaultRegistry();
    const kinds =
      args.positionals[0] === undefined ? ALL_KINDS : [resolveKind(args.positionals[0])];
    const asJson = args.flags.get('json') === true;

    if (asJson) {
      const out: Record<string, unknown[]> = {};
      for (const kind of kinds) {
        out[kind] = registry.list(kind).map((d) => ({ type: d.type, description: d.description }));
      }
      writeLine(ctx.env.stdout, JSON.stringify(out, null, 2));
      return EXIT_OK;
    }

    const paint = new Painter(ctx.color);
    for (const kind of kinds) {
      const defs = registry.list(kind);
      writeLine(ctx.env.stdout, paint.bold(KIND_LABEL[kind]));
      if (defs.length === 0) {
        writeLine(ctx.env.stdout, '  (none)');
      } else {
        const width = Math.max(...defs.map((d) => d.type.length)) + 2;
        for (const d of defs) {
          writeLine(ctx.env.stdout, `  ${paint.cyan(d.type.padEnd(width))}${d.description}`);
        }
      }
      writeLine(ctx.env.stdout);
    }
    return EXIT_OK;
  },
};
