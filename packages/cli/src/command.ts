import type { CommandSpec, ParsedArgs } from './args.js';
import type { CliEnvironment } from './environment.js';

/** Everything a command implementation needs, beyond its own parsed arguments. */
export interface CliContext {
  readonly env: CliEnvironment;
  /** Whether ANSI colour is enabled for this invocation (`NO_COLOR`/`FORCE_COLOR`/TTY). */
  readonly color: boolean;
  /** Whether `--debug` was given: unexpected errors show a full stack. */
  readonly debug: boolean;
}

/** One `ferrule` subcommand: its declarative spec (for parsing and help) and its implementation. */
export interface Command {
  readonly spec: CommandSpec;
  run(ctx: CliContext, args: ParsedArgs): Promise<number>;
}
