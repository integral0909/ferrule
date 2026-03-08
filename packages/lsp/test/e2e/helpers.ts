import { PassThrough } from 'node:stream';
import {
  encodeFrame,
  FrameDecoder,
  ManualScheduler,
  startLanguageServer,
  type LanguageServer,
} from '@ferrule/lsp';

/** A decoded JSON-RPC message, loosely typed for test assertions. */
export interface RpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface TestServer {
  readonly server: LanguageServer;
  readonly scheduler: ManualScheduler;
  readonly received: readonly RpcMessage[];
  /** Exit codes passed to `onExit` so far, in order (see `LanguageServerOptions.onExit`). */
  readonly exitCodes: readonly number[];
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  /** Waits for the next received message matching `predicate` (polls, since streams are async). */
  waitFor(predicate: (m: RpcMessage) => boolean): Promise<RpcMessage>;
  /** Waits for the next `textDocument/publishDiagnostics` notification for `uri`. */
  waitForDiagnostics(uri: string): Promise<RpcMessage>;
  dispose(): void;
}

/**
 * Spins up a real {@link startLanguageServer} instance wired to a pair of in-memory `PassThrough`
 * streams, and a thin JSON-RPC client on the other end — this is what every end-to-end test in
 * this directory drives. Diagnostics use a {@link ManualScheduler}, so tests control exactly when
 * a debounced publish fires via `scheduler.flush()`.
 */
export function createTestServer(): TestServer {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const scheduler = new ManualScheduler();
  const exitCodes: number[] = [];
  const server = startLanguageServer({
    input: clientToServer,
    output: serverToClient,
    scheduler,
    onExit: (code) => exitCodes.push(code),
  });

  const decoder = new FrameDecoder();
  const received: RpcMessage[] = [];
  serverToClient.on('data', (chunk: Buffer) => {
    received.push(...(decoder.push(chunk) as RpcMessage[]));
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  serverToClient.on('data', () => {
    for (const message of received) {
      if (
        message.id === undefined ||
        (message.result === undefined && message.error === undefined)
      ) {
        continue;
      }
      const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (waiter === undefined) continue;
      pending.delete(message.id as number);
      if (message.error !== undefined) waiter.reject(message.error);
      else waiter.resolve(message.result);
    }
  });

  function sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      clientToServer.write(
        encodeFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
      );
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    clientToServer.write(
      encodeFrame({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    );
  }

  async function waitFor(predicate: (m: RpcMessage) => boolean): Promise<RpcMessage> {
    for (let i = 0; i < 1000; i++) {
      const found = received.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('timed out waiting for a matching message');
  }

  function waitForDiagnostics(uri: string): Promise<RpcMessage> {
    const alreadySeen = received.filter(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' && (m.params as { uri: string }).uri === uri,
    ).length;
    let seenSoFar = 0;
    return waitFor((m) => {
      if (m.method !== 'textDocument/publishDiagnostics') return false;
      if ((m.params as { uri: string }).uri !== uri) return false;
      seenSoFar++;
      return seenSoFar > alreadySeen;
    });
  }

  return {
    server,
    scheduler,
    received,
    exitCodes,
    sendRequest,
    sendNotification,
    waitFor,
    waitForDiagnostics,
    dispose: () => server.dispose(),
  };
}

/** Opens `text` as `uri` and waits for the resulting `publishDiagnostics`, returning it. */
export async function openDocument(
  client: TestServer,
  uri: string,
  text: string,
  languageId = 'ferrule',
): Promise<RpcMessage> {
  const diagnostics = client.waitForDiagnostics(uri);
  client.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId, version: 1, text },
  });
  return diagnostics;
}
