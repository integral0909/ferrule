import { PassThrough } from 'node:stream';
import { ManualClock, type Clock } from '@ferrule/runtime';
import type { CliEnvironment, CliSignal, SignalSource } from '../../src/environment.js';

/** A `SignalSource` tests can trigger directly, without touching the real process. */
export class FakeSignalSource implements SignalSource {
  private readonly handlers = new Map<CliSignal, Set<() => void>>();

  on(signal: CliSignal, handler: () => void): () => void {
    const set = this.handlers.get(signal) ?? new Set();
    set.add(handler);
    this.handlers.set(signal, set);
    return () => {
      this.handlers.get(signal)?.delete(handler);
    };
  }

  emit(signal: CliSignal): void {
    for (const handler of [...(this.handlers.get(signal) ?? [])]) handler();
  }

  listenerCount(signal: CliSignal): number {
    return this.handlers.get(signal)?.size ?? 0;
  }
}

/** A `PassThrough` with an assignable `isTTY`, satisfying both `CliReadable`/`CliWritable` and
 * the full `NodeJS.ReadableStream`/`WritableStream` interfaces the `lsp` command needs. */
export class FakeStream extends PassThrough {
  isTTY = false;
}

export interface FakeEnvironment extends CliEnvironment {
  readonly stdinStream: FakeStream;
  readonly stdoutStream: FakeStream;
  readonly stderrStream: FakeStream;
  readonly fakeSignals: FakeSignalSource;
  readonly hardExitCalls: number[];
  stdoutText(): string;
  stderrText(): string;
  /** Writes to stdin and lets pending readers observe it before returning. */
  feedStdin(text: string): Promise<void>;
  endStdin(): void;
}

export interface CreateFakeEnvironmentOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly clock?: Clock;
  readonly stdoutIsTTY?: boolean;
  readonly stdinIsTTY?: boolean;
}

export function createFakeEnvironment(options: CreateFakeEnvironmentOptions = {}): FakeEnvironment {
  const stdinStream = new FakeStream();
  const stdoutStream = new FakeStream();
  const stderrStream = new FakeStream();
  stdoutStream.isTTY = options.stdoutIsTTY ?? false;
  stdinStream.isTTY = options.stdinIsTTY ?? false;

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  stdoutStream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf8')));
  stderrStream.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

  const fakeSignals = new FakeSignalSource();
  const hardExitCalls: number[] = [];

  const env: FakeEnvironment = {
    argv: options.argv ?? [],
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    stdin: stdinStream,
    stdout: stdoutStream,
    stderr: stderrStream,
    clock: options.clock ?? new ManualClock(),
    signals: fakeSignals,
    version: '0.0.0-test',
    hardExit: (code: number) => {
      hardExitCalls.push(code);
    },
    stdinStream,
    stdoutStream,
    stderrStream,
    fakeSignals,
    hardExitCalls,
    stdoutText: () => stdoutChunks.join(''),
    stderrText: () => stderrChunks.join(''),
    feedStdin: async (text: string) => {
      stdinStream.write(text);
      await new Promise((resolve) => setImmediate(resolve));
    },
    endStdin: () => {
      stdinStream.end();
    },
  };
  return env;
}
