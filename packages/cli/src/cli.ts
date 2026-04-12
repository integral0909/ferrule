import { isFerruleError } from '@ferrule/core';
import { closestMatch } from '@ferrule/schema';
import {
  formatCommandHelp,
  formatTopLevelHelp,
  parseArgs,
  withGlobalFlags,
  type TopLevelCommandSummary,
} from './args.js';
import { benchCommand } from './commands/bench.js';
import { describeCommand } from './commands/describe.js';
import { evalCommand } from './commands/eval.js';
import { explainCommand } from './commands/explain.js';
import { fmtCommand } from './commands/fmt.js';
import { generateCommand } from './commands/generate.js';
import { listCommand } from './commands/list.js';
import { lspCommand } from './commands/lsp.js';
import { replCommand } from './commands/repl.js';
import { runCommand } from './commands/run.js';
import { tapCommand } from './commands/tap.js';
import { testCommand } from './commands/test.js';
import { topCommand } from './commands/top.js';
import { validateCommand } from './commands/validate.js';
import type { CliContext, Command } from './command.js';
import { shouldUseColor } from './color.js';
import type { CliEnvironment } from './environment.js';
import { CliError } from './errors.js';
import { EXIT_OK, EXIT_RUNTIME_FAILURE, EXIT_USAGE_ERROR } from './exit-codes.js';
import { writeLine } from './output.js';

const COMMANDS: readonly Command[] = [
  runCommand,
  validateCommand,
  testCommand,
  tapCommand,
  topCommand,
  fmtCommand,
  replCommand,
  evalCommand,
  listCommand,
  describeCommand,
  explainCommand,
  generateCommand,
  benchCommand,
  lspCommand,
];

const commandsByName = new Map<string, Command>(COMMANDS.map((c) => [c.spec.name, c]));

function summaries(): TopLevelCommandSummary[] {
  return COMMANDS.map((c) => ({ name: c.spec.name, summary: c.spec.summary }));
}

/**
 * Runs the `ferrule` CLI against `env` and returns the process exit code. Never throws: every
 * error is caught and turned into a message on `env.stderr` plus the matching exit code, exactly
 * as the real binary should behave. `bin.ts` is the only caller that turns the result into an
 * actual `process.exitCode`.
 */
export async function runCli(env: CliEnvironment): Promise<number> {
  const color = shouldUseColor(env.env, env.stdout);
  const debug = env.argv.includes('--debug');

  try {
    return await dispatch(env, color, debug);
  } catch (error) {
    return reportError(env, error, color, debug);
  }
}

async function dispatch(env: CliEnvironment, color: boolean, debug: boolean): Promise<number> {
  const [first, ...rest] = env.argv;

  if (first === undefined || first === '--help' || first === '-h') {
    writeLine(env.stdout, formatTopLevelHelp(summaries(), env.version));
    return EXIT_OK;
  }
  if (first === '--version' || first === '-v') {
    writeLine(env.stdout, env.version);
    return EXIT_OK;
  }

  const command = commandsByName.get(first);
  if (command === undefined) {
    const suggestion = closestMatch(first, commandsByName.keys());
    writeLine(
      env.stderr,
      `unknown command ${JSON.stringify(first)}` +
        (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
    );
    writeLine(env.stderr, '');
    writeLine(env.stderr, formatTopLevelHelp(summaries(), env.version));
    return EXIT_USAGE_ERROR;
  }

  const spec = withGlobalFlags(command.spec);
  const outcome = parseArgs(spec, rest);
  if (!outcome.ok) {
    writeLine(env.stderr, `ferrule ${command.spec.name}: ${outcome.message}`);
    writeLine(env.stderr, '');
    writeLine(env.stderr, formatCommandHelp(spec));
    return EXIT_USAGE_ERROR;
  }

  if (outcome.args.flags.get('help') === true) {
    writeLine(env.stdout, formatCommandHelp(spec));
    return EXIT_OK;
  }

  const ctx: CliContext = { env, color, debug: debug || outcome.args.flags.get('debug') === true };
  try {
    return await command.run(ctx, outcome.args);
  } catch (error) {
    return reportError(env, error, color, ctx.debug, command.spec.name);
  }
}

function reportError(
  env: CliEnvironment,
  error: unknown,
  color: boolean,
  debug: boolean,
  commandName?: string,
): number {
  const prefix = commandName === undefined ? 'ferrule' : `ferrule ${commandName}`;
  if (error instanceof CliError) {
    writeLine(env.stderr, `${prefix}: ${error.message}`);
    if (debug && error.stack !== undefined) writeLine(env.stderr, error.stack);
    return error.exitCode;
  }
  if (isFerruleError(error)) {
    writeLine(env.stderr, `${prefix}: ${error.message}`);
    if (debug && error.stack !== undefined) writeLine(env.stderr, error.stack);
    return EXIT_RUNTIME_FAILURE;
  }
  if (error instanceof Error) {
    writeLine(env.stderr, debug ? (error.stack ?? error.message) : `${prefix}: ${error.message}`);
    return EXIT_RUNTIME_FAILURE;
  }
  writeLine(env.stderr, `${prefix}: ${String(error)}`);
  return EXIT_RUNTIME_FAILURE;
}
