import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { format } from '@ferrule/script';
import { withGlobalFlags } from '../args.js';
import { EXIT_OK } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { readAll, write, writeLine } from '../output.js';
import type { Command } from '../command.js';

export const fmtCommand: Command = {
  spec: withGlobalFlags({
    name: 'fmt',
    summary: 'Format Ferrule Script (.fe) files.',
    usage: 'ferrule fmt [files...] [options]',
    flags: [
      {
        name: 'check',
        type: 'boolean',
        description: 'Only report which files would change; exit 1 if any would.',
      },
      {
        name: 'stdin',
        type: 'boolean',
        description: 'Read a program from stdin, write formatted output to stdout.',
      },
    ],
    positionals: [{ name: 'files', description: '.fe files to format in place.', variadic: true }],
    examples: [
      'ferrule fmt pipeline/*.fe',
      'ferrule fmt --check .',
      'cat a.fe | ferrule fmt --stdin',
    ],
  }),

  async run(ctx, args) {
    const check = args.flags.get('check') === true;
    const stdin = args.flags.get('stdin') === true;

    if (stdin) {
      const source = await readAll(ctx.env.stdin);
      write(ctx.env.stdout, format(source));
      return EXIT_OK;
    }

    if (args.positionals.length === 0) {
      throw new UsageError('give one or more .fe files, or pass --stdin');
    }

    let anyChanged = false;
    for (const relative of args.positionals) {
      const path = isAbsolute(relative) ? relative : resolve(ctx.env.cwd, relative);
      const source = await readFile(path, 'utf8');
      const formatted = format(source);
      if (formatted === source) continue;
      anyChanged = true;
      if (check) {
        writeLine(ctx.env.stdout, `would reformat ${relative}`);
      } else {
        await writeFile(path, formatted, 'utf8');
        writeLine(ctx.env.stdout, `reformatted ${relative}`);
      }
    }

    if (check && anyChanged) return 1;
    return EXIT_OK;
  },
};
