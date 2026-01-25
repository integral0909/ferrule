/**
 * Writes `chunk` to `stream`, resolving once it is safe to write again: immediately if the
 * stream's internal buffer has room (`write` returned `true`), or after the next `'drain'` event
 * otherwise. This is the Node-documented way to respect a writable stream's backpressure, shared
 * by every sink that writes framed bytes to a stream (console, TCP sockets).
 */
export function writeWithBackpressure(
  stream: NodeJS.WritableStream,
  chunk: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let ok: boolean;
  try {
    ok = stream.write(buffer);
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the stream's thrown value as-is
    return Promise.reject(error);
  }
  if (ok) return Promise.resolve();
  if (signal?.aborted === true) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
    return Promise.reject(signal.reason as unknown);
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
      reject(signal!.reason as unknown);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
