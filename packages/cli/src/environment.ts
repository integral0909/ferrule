import type { Clock } from '@ferrule/runtime';
import { SystemClock } from '@ferrule/runtime';
import { packageVersion } from './pkg-info.js';

/**
 * The subset of a readable stream the CLI needs: async iteration over chunks, plus TTY detection.
 * `process.stdin` satisfies this structurally, and tests can pass anything that does too (for
 * example a `Readable.from([...])`).
 */
export interface CliReadable extends AsyncIterable<Buffer | string> {
  readonly isTTY?: boolean;
}

/** The subset of a writable stream the CLI needs. `process.stdout`/`process.stderr` satisfy this. */
export interface CliWritable {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

export type CliSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** A source of OS signals, injectable so tests never touch the real process. */
export interface SignalSource {
  /** Registers `handler` for `signal`; returns a function that unregisters it. */
  on(signal: CliSignal, handler: () => void): () => void;
}

/** Wraps the real Node process's signal delivery. */
export class ProcessSignalSource implements SignalSource {
  on(signal: CliSignal, handler: () => void): () => void {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  }
}

/**
 * Everything a command needs from the outside world, gathered into one injectable object so
 * tests can run every command against fakes instead of the real process.
 */
export interface CliEnvironment {
  /** Arguments after the command name (i.e. `process.argv.slice(2)` for the real process). */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly stdin: CliReadable;
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  readonly clock: Clock;
  readonly signals: SignalSource;
  /** The `ferrule` package version, for `--version`. */
  readonly version: string;
  /**
   * Terminates the process immediately, bypassing any further graceful shutdown (`ferrule run`
   * calls this on a second SIGINT/SIGTERM). The real implementation calls `process.exit(code)`;
   * tests supply a fake that records the call instead so a forced exit can be asserted on without
   * ending the test process itself.
   */
  readonly hardExit: (code: number) => void;
}

export interface CreateNodeEnvironmentOptions {
  readonly argv?: readonly string[];
}

/** Builds a {@link CliEnvironment} backed by the real process. Used only by `bin.ts`. */
export function createNodeEnvironment(options: CreateNodeEnvironmentOptions = {}): CliEnvironment {
  return {
    argv: options.argv ?? process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    clock: new SystemClock(),
    signals: new ProcessSignalSource(),
    version: packageVersion(),
    hardExit: (code: number) => process.exit(code),
  };
}
