import { AdminClient, AdminClientError } from '@ferrule/admin';
import { encodeJson } from '@ferrule/core';
import { flagNumber, flagString, withGlobalFlags } from '../args.js';
import type { Command } from '../command.js';
import { EXIT_OK, EXIT_RUNTIME_FAILURE } from '../exit-codes.js';
import { UsageError } from '../errors.js';
import { writeLine } from '../output.js';

export const tapCommand: Command = {
  spec: withGlobalFlags({
    name: 'tap',
    summary: "Stream a running pipeline's events from a component's output.",
    usage: 'ferrule tap <component> [options]',
    flags: [
      {
        name: 'api-address',
        type: 'string',
        default: '127.0.0.1:9090',
        description: "The admin API's address.",
      },
      {
        name: 'token',
        type: 'string',
        description: 'Admin API bearer token. Defaults to $FERRULE_API_TOKEN.',
      },
      {
        name: 'port',
        type: 'string',
        description: "The component's output port to tap. Defaults to its default port.",
      },
      {
        name: 'sample',
        type: 'number',
        description: 'Sampling rate in (0, 1]. Default 1 (every event).',
      },
      { name: 'limit', type: 'integer', description: 'Stop after this many events.' },
      {
        name: 'format',
        type: 'enum',
        enumValues: ['pretty', 'ndjson'],
        default: 'pretty',
        description: 'Output format.',
      },
    ],
    positionals: [{ name: 'component', description: 'The component ID to tap.', required: true }],
    examples: ['ferrule tap app_logs', 'ferrule tap shape --port errors --format ndjson'],
  }),

  async run(ctx, args) {
    const component = args.positionals[0];
    if (component === undefined) throw new UsageError('missing required argument <component>');

    const baseUrl = `http://${flagString(args, 'api-address') ?? '127.0.0.1:9090'}`;
    const token = flagString(args, 'token') ?? ctx.env.env['FERRULE_API_TOKEN'];
    const client = new AdminClient({ baseUrl, ...(token !== undefined ? { token } : {}) });

    const port = flagString(args, 'port');
    const sample = flagNumber(args, 'sample');
    const limit = flagNumber(args, 'limit');
    const format = flagString(args, 'format') ?? 'pretty';

    try {
      for await (const event of client.tap(component, {
        ...(port !== undefined ? { port } : {}),
        ...(sample !== undefined ? { sample } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })) {
        if (format === 'ndjson') {
          writeLine(ctx.env.stdout, encodeJson(event));
        } else {
          writeLine(ctx.env.stdout, encodeJson(event, { indent: 2 }));
        }
      }
    } catch (error) {
      if (error instanceof AdminClientError) {
        writeLine(ctx.env.stderr, `${error.code}: ${error.message}`);
        return EXIT_RUNTIME_FAILURE;
      }
      throw error;
    }
    return EXIT_OK;
  },
};
