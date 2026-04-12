/**
 * The `ferrule` command-line interface: `run`, `validate`, `test`, `tap`, `top`, `fmt`, `repl`,
 * `eval`, `list`, `describe`, `explain`, `generate`, `bench`, and `lsp`. See the package README
 * for a full command reference. `bin.ts` is the actual executable entry point (`ferrule`); this
 * module exists so the CLI's pieces (the argument parser, the environment abstraction, and
 * `runCli` itself) can be imported and tested, or embedded, without going through a subprocess.
 */

export { runCli } from './cli.js';

export {
  createNodeEnvironment,
  ProcessSignalSource,
  type CliEnvironment,
  type CliReadable,
  type CliSignal,
  type CliWritable,
  type CreateNodeEnvironmentOptions,
  type SignalSource,
} from './environment.js';

export type { CliContext, Command } from './command.js';

export {
  formatCommandHelp,
  formatTopLevelHelp,
  parseArgs,
  withGlobalFlags,
  flagBoolean,
  flagNumber,
  flagString,
  flagStringArray,
  type CommandSpec,
  type FlagSpec,
  type FlagType,
  type FlagValue,
  type ParsedArgs,
  type ParseOutcome,
  type PositionalSpec,
  type TopLevelCommandSummary,
} from './args.js';

export { CliError, CliConfigError, UsageError } from './errors.js';
export {
  EXIT_CONFIG_ERROR,
  EXIT_OK,
  EXIT_RUNTIME_FAILURE,
  EXIT_TESTS_FAILED,
  EXIT_USAGE_ERROR,
  type ExitCode,
} from './exit-codes.js';

export { buildDefaultRegistry, builtinComponents } from './registry.js';
export { packageVersion } from './pkg-info.js';
export { shouldUseColor, Painter, type ColorCapableStream, type ColorName } from './color.js';
