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

/** Reads newline-delimited lines from `res` until `count` non-empty lines have arrived. */
export function readLines(
  res: IncomingMessage,
  count: number,
  timeoutMs = 5000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      res.removeListener('data', onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${count} line(s); got ${lines.length}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) lines.push(line);
        if (lines.length >= count) {
          cleanup();
          resolve(lines);
          return;
        }
        idx = buffer.indexOf('\n');
      }
    };
    res.on('data', onData);
    res.on('error', (error: Error) => {
      cleanup();
      reject(error);
    });
  });
}

/** Reads whatever lines arrive from `res` over a fixed window, then stops (without ending the
 * connection). Used where the exact count is nondeterministic (e.g. sampling, drops). */
export function collectLinesForMs(res: IncomingMessage, ms: number): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) lines.push(line);
        idx = buffer.indexOf('\n');
      }
    };
    res.on('data', onData);
    setTimeout(() => {
      res.removeListener('data', onData);
      resolve(lines);
    }, ms);
  });
}

/** Waits until `predicate()` is true, polling every few milliseconds. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
