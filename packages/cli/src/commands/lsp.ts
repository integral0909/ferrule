import { startLanguageServer } from '@ferrule/lsp';
import { withGlobalFlags } from '../args.js';
import type { Command } from '../command.js';
import { EXIT_OK } from '../exit-codes.js';

/**
 * Starts the Ferrule Script language server on stdio. `startLanguageServer` needs full
 * `NodeJS.ReadableStream`/`WritableStream` objects (it pipes them straight into its own JSON-RPC
 * framing), not just the minimal `CliReadable`/`CliWritable` the rest of this package uses — in
 * the real binary `ctx.env.stdin`/`stdout` *are* `process.stdin`/`process.stdout`, which satisfy
 * that fully; tests exercise this command with real Node streams (e.g. `PassThrough`) rather than
 * the lighter fakes used elsewhere.
 */
export const lspCommand: Command = {
  spec: withGlobalFlags({
    name: 'lsp',
    summary: 'Start the Ferrule Script language server on stdio.',
    usage: 'ferrule lsp',
    flags: [],
  }),

  async run(ctx) {
    let resolveDone!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      resolveDone = resolve;
    });

    const server = startLanguageServer({
      input: ctx.env.stdin as unknown as NodeJS.ReadableStream,
      output: ctx.env.stdout as unknown as NodeJS.WritableStream,
      onExit: (code) => resolveDone(code),
    });

    const unsubs = [
      ctx.env.signals.on('SIGINT', () => {
        server.dispose();
        resolveDone(EXIT_OK);
      }),
      ctx.env.signals.on('SIGTERM', () => {
        server.dispose();
        resolveDone(EXIT_OK);
      }),
    ];

    try {
      return await done;
    } finally {
      for (const unsub of unsubs) unsub();
    }
  },
};
