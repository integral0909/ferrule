import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { encodeJson, LogEvent, parseJson } from '@ferrule/core';
import {
  compile,
  createDefaultImplementations,
  parseAndCheck,
  renderDiagnostics,
  SourceFile,
} from '@ferrule/script';
import { withGlobalFlags } from '../args.js';
import { EXIT_CONFIG_ERROR, EXIT_OK } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { readLines, writeLine } from '../output.js';
import type { Command } from '../command.js';

export const evalCommand: Command = {
  spec: withGlobalFlags({
    name: 'eval',
    summary: 'Run a Ferrule Script program over NDJSON input, one event per line.',
    usage: "ferrule eval -e '<program>' [options]",
    flags: [
      {
        name: 'program',
        short: 'e',
        type: 'string',
        description: 'The Ferrule Script program source.',
      },
      {
        name: 'file',
        short: 'f',
        type: 'path',
        description: 'Read the program from a file instead of -e.',
      },
      {
        name: 'input',
        short: 'i',
        type: 'path',
        description: 'NDJSON input file. Defaults to stdin.',
      },
    ],
    examples: [
      String.raw`ferrule eval -e '.upper = upcase(.message) ?? .message' --input events.ndjson`,
      String.raw`echo '{"message":"hi"}' | ferrule eval -e 'del(.debug)'`,
    ],
  }),

  async run(ctx, args) {
    const inlineProgram = args.flags.get('program');
    const programFile = args.flags.get('file');
    let source: string;
    let sourceName: string;
    if (typeof inlineProgram === 'string') {
      source = inlineProgram;
      sourceName = '<eval>';
    } else if (typeof programFile === 'string') {
      const path = isAbsolute(programFile) ? programFile : resolve(ctx.env.cwd, programFile);
      source = await readFile(path, 'utf8');
      sourceName = programFile;
    } else {
      throw new UsageError('give a program with -e/--program or -f/--file');
    }

    const file = new SourceFile(sourceName, source);
    const result = parseAndCheck(file);
    const diagnostics = [...result.parseDiagnostics, ...result.diagnostics];
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      writeLine(ctx.env.stderr, renderDiagnostics(diagnostics, file, { color: ctx.color }));
      return EXIT_CONFIG_ERROR;
    }

    const program = compile(result, { implementations: createDefaultImplementations() });

    const inputPath = args.flags.get('input');
    const inputText =
      typeof inputPath === 'string'
        ? await readFile(
            isAbsolute(inputPath) ? inputPath : resolve(ctx.env.cwd, inputPath),
            'utf8',
          )
        : undefined;

    const lines: AsyncIterable<string> =
      inputText === undefined ? readLines(ctx.env.stdin) : linesOf(inputText);

    let hadAbort = false;
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let event: LogEvent;
      try {
        const value = parseJson(line);
        if (!(value instanceof Map)) throw new Error('each input line must be a JSON object');
        event = new LogEvent(value);
      } catch (error) {
        writeLine(ctx.env.stderr, `skipping invalid input line: ${describe(error)}`);
        continue;
      }
      const outcome = program.run(event);
      if (outcome.kind === 'continue') {
        for (const out of outcome.events) writeLine(ctx.env.stdout, encodeJson(out.fields));
      } else if (outcome.kind === 'abort') {
        hadAbort = true;
        writeLine(ctx.env.stderr, `abort: ${outcome.reason}`);
      }
      // 'drop' produces no output line, by design.
    }

    return hadAbort ? EXIT_CONFIG_ERROR : EXIT_OK;
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// eslint-disable-next-line @typescript-eslint/require-await -- async only to match readLines()'s AsyncGenerator type
async function* linesOf(text: string): AsyncGenerator<string, void, void> {
  for (const line of text.split('\n')) yield line;
}
