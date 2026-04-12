import type { ExitCode } from './exit-codes.js';
import { EXIT_CONFIG_ERROR, EXIT_USAGE_ERROR } from './exit-codes.js';

/**
 * An error a command wants reported as a clean one-line message (no stack trace, unless
 * `--debug` is set) with a specific process exit code. Thrown by command implementations for
 * expected failure modes (bad flags, a config that doesn't validate, a component that isn't
 * registered); anything else escaping a command is treated as an unexpected bug.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Bad arguments: unknown command, unknown flag, missing required value, wrong positional count. */
export class UsageError extends CliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, EXIT_USAGE_ERROR, options);
    this.name = 'UsageError';
  }
}

/** A configuration, schema, topology, or script problem found while validating or running. */
export class CliConfigError extends CliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, EXIT_CONFIG_ERROR, options);
    this.name = 'CliConfigError';
  }
}
