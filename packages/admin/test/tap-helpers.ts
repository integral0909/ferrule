import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';

export interface RawResponse {
  readonly req: ClientRequest;
  readonly res: IncomingMessage;
}

/** Opens a raw connection and resolves once response headers arrive, without ever reading the
 * body — the response stream stays paused until something attaches a `data` listener. Used both
 * for normal streaming reads and to simulate a slow client that never reads at all. */
export function openRaw(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Reads newline-delimited lines from `res` until at least `count` non-empty lines have arrived.
 *
 * Resolves with every complete line received by then, which can be *more* than `count` when the
 * chunk that satisfied the count carried several: stopping mid-chunk at exactly `count` used to
 * drop the rest of that chunk on the floor, silently losing data for any caller that read a few
 * lines and then went looking for the remainder. If you need to keep reading after this resolves,
 * use {@link collectLines} or {@link readLinesUntilEnd}, which own the stream for the whole read.
 *
 * `timeoutMs` is wall-clock, so it is only a safety net for a stream that never delivers — the
 * surrounding test's own timeout is the real backstop. It is deliberately generous for that
 * reason: a starved worker thread should make this wait, not fail.
 */
export function readLines(
  res: IncomingMessage,
  count: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${count} line(s); got ${lines.length}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer = takeLines(buffer + chunk.toString('utf8'), lines);
      if (lines.length >= count) {
        cleanup();
        resolve(lines);
      }
    };
    // Without this, a stream that closes early would sit here until `timeoutMs` and then blame a
    // timeout for what is really "the server stopped sending".
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`stream ended after ${lines.length} line(s), expected ${count}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
  });
}

/** Reads every line the server sends and resolves when it ends the response. Where a test's
 * expectation is "this many lines and no more", this is the deterministic way to check it: the
 * server closing the stream is a real signal, so a starved worker thread makes this wait longer
 * rather than conclude early — unlike a fixed "and then nothing else arrived" window, which a
 * stall satisfies vacuously. */
export function readLinesUntilEnd(res: IncomingMessage, timeoutMs = 10_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`timed out waiting for the stream to end; got ${lines.length} line(s) so far`),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer = takeLines(buffer + chunk.toString('utf8'), lines);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(lines);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
  });
}

export interface CollectLinesOptions {
  /** Don't resolve before this many non-empty lines have arrived. Default 0. */
  readonly minLines?: number;
  /** Once `minLines` have arrived, stop after this long with no further data. Default 200. */
  readonly quietMs?: number;
  /** Reject if `minLines` haven't arrived within this long. Default 10_000. */
  readonly timeoutMs?: number;
}

/**
 * Collects lines from `res` until the stream has been quiet for `quietMs` — but never before
 * `minLines` have arrived, and never longer than `timeoutMs` waiting for them.
 *
 * Use this, not a fixed collection window, wherever a test asserts that *something* arrived. A
 * fixed window is decided by the wall clock while the data it waits for is decided by the event
 * loop, and the two only track each other while the worker thread is actually running. Stall that
 * thread past the end of the window — which is exactly what a loaded full-suite run does, since
 * the pipeline, the admin server and the HTTP client all share it — and on resume Node runs the
 * expiring timer in the timers phase before it ever polls the socket: the window resolves with
 * nothing although every byte had already been written. Waiting for a line instead means
 * starvation can only make this slower, never make it report less.
 *
 * The quiet period is still wall-clock, so this bounds how *many* lines arrived only from above
 * (a starved collection can end early with fewer). Where an exact count is the point, use
 * {@link readLinesUntilEnd} and let the server close the stream.
 */
export function collectLines(
  res: IncomingMessage,
  options: CollectLinesOptions = {},
): Promise<string[]> {
  const minLines = options.minLines ?? 0;
  const quietMs = options.quietMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = '';
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(deadline);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onError);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${minLines} line(s); got ${lines.length}`));
    }, timeoutMs);
    const armQuiet = (): void => {
      if (lines.length < minLines) return;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolve(lines);
      }, quietMs);
    };
    const onData = (chunk: Buffer): void => {
      buffer = takeLines(buffer + chunk.toString('utf8'), lines);
      armQuiet();
    };
    const onEnd = (): void => {
      cleanup();
      if (lines.length >= minLines) resolve(lines);
      else {
        reject(
          new Error(`stream ended after ${lines.length} line(s), expected at least ${minLines}`),
        );
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
    armQuiet(); // minLines === 0: there is nothing to wait for but the quiet period
  });
}

/** Appends every complete non-empty line in `buffer` to `lines`, returning the trailing partial. */
function takeLines(buffer: string, lines: string[]): string {
  let rest = buffer;
  let idx = rest.indexOf('\n');
  while (idx !== -1) {
    const line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.length > 0) lines.push(line);
    idx = rest.indexOf('\n');
  }
  return rest;
}

/** Waits until `predicate()` is true, polling every few milliseconds. The budget is wall-clock
 * and only a safety net, so it matches the readers above: a starved worker thread should make
 * this wait, not fail. The surrounding test's own timeout is the real backstop. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
