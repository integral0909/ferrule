/**
 * Process exit codes the `ferrule` binary uses, consistently across every command.
 *
 * | Code | Meaning                                                              |
 * | ---- | --------------------------------------------------------------------- |
 * | 0    | success                                                               |
 * | 1    | runtime failure (an operation failed while running)                  |
 * | 2    | usage error (bad arguments, unknown command/flag)                    |
 * | 3    | configuration or validation error (bad config, topology, or script)  |
 * | 4    | tests failed (`ferrule test`, or `ferrule fmt --check` needs changes)|
 */
export const EXIT_OK = 0;
export const EXIT_RUNTIME_FAILURE = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_CONFIG_ERROR = 3;
export const EXIT_TESTS_FAILED = 4;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_RUNTIME_FAILURE
  | typeof EXIT_USAGE_ERROR
  | typeof EXIT_CONFIG_ERROR
  | typeof EXIT_TESTS_FAILED;
