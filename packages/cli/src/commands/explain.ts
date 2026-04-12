import { DIAGNOSTIC_CATALOG, explainCode } from '@ferrule/script';
import { withGlobalFlags } from '../args.js';
import { allCliCatalogEntries, explainCliCode } from '../diagnostics-catalog.js';
import { EXIT_OK } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { writeLine } from '../output.js';
import { Painter } from '../color.js';
import type { Command } from '../command.js';

export const explainCommand: Command = {
  spec: withGlobalFlags({
    name: 'explain',
    summary: 'Explain a diagnostic code (script, topology, or config).',
    usage: 'ferrule explain <code> [options]',
    flags: [
      {
        name: 'list',
        type: 'boolean',
        description: 'List every known diagnostic code instead of explaining one.',
      },
    ],
    positionals: [{ name: 'code', description: 'A diagnostic code, e.g. `E301` or `E_CYCLE`.' }],
    examples: ['ferrule explain E301', 'ferrule explain E_CYCLE', 'ferrule explain --list'],
  }),

  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the Command.run contract async uniformly
  async run(ctx, args) {
    const paint = new Painter(ctx.color);
    if (args.flags.get('list') === true) {
      for (const entry of DIAGNOSTIC_CATALOG) {
        writeLine(ctx.env.stdout, `${paint.cyan(entry.code)}  ${entry.summary}`);
      }
      for (const entry of allCliCatalogEntries()) {
        writeLine(ctx.env.stdout, `${paint.cyan(entry.code)}  ${entry.summary}`);
      }
      return EXIT_OK;
    }

    const code = args.positionals[0];
    if (code === undefined) throw new UsageError('missing required argument <code>');

    const scriptEntry = explainCode(code);
    const cliEntry = scriptEntry === undefined ? explainCliCode(code) : undefined;
    const entry = scriptEntry ?? cliEntry;
    if (entry === undefined) {
      throw new UsageError(
        `unknown diagnostic code ${JSON.stringify(code)}; run \`ferrule explain --list\` to see every known code`,
      );
    }

    writeLine(ctx.env.stdout, `${paint.bold(entry.code)} ${paint.dim(`[${entry.severity}]`)}`);
    writeLine(ctx.env.stdout, entry.summary);
    writeLine(ctx.env.stdout);
    writeLine(ctx.env.stdout, entry.explanation);
    return EXIT_OK;
  },
};
