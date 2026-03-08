import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  ErrorCodes,
  FrameDecoder,
  MessageConnection,
  ResponseErrorException,
} from '@ferrule/lsp';

interface DecodedMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

function harness() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const errors: unknown[] = [];
  const connection = new MessageConnection({
    transport: { input: clientToServer, output: serverToClient },
    onError: (error) => errors.push(error),
  });
  connection.listen();

  const decoder = new FrameDecoder();
  const received: DecodedMessage[] = [];
  serverToClient.on('data', (chunk: Buffer) => {
    received.push(...(decoder.push(chunk) as DecodedMessage[]));
  });

  function send(message: unknown): void {
    clientToServer.write(encodeFrame(message));
  }

  async function waitFor(predicate: (m: DecodedMessage) => boolean): Promise<DecodedMessage> {
    for (let i = 0; i < 500; i++) {
      const found = received.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('timed out waiting for a matching message');
  }

  return { connection, send, received, errors, waitFor };
}

describe('MessageConnection', () => {
  it('dispatches a request to its handler and returns the result', async () => {
    const h = harness();
    h.connection.onRequest('ping', () => 'pong');
    h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const response = await h.waitFor((m) => m.id === 1);
    expect(response.result).toBe('pong');
  });

  it('awaits an async handler before responding', async () => {
    const h = harness();
    h.connection.onRequest(
      'slowPing',
      () => new Promise((resolve) => setTimeout(() => resolve('pong'), 5)),
    );
    h.send({ jsonrpc: '2.0', id: 1, method: 'slowPing' });
    const response = await h.waitFor((m) => m.id === 1);
    expect(response.result).toBe('pong');
  });

  it('maps a handler returning undefined to a null result', async () => {
    const h = harness();
    h.connection.onRequest('nothing', () => undefined);
    h.send({ jsonrpc: '2.0', id: 1, method: 'nothing' });
    const response = await h.waitFor((m) => m.id === 1);
    expect(response.result).toBeNull();
  });

  it('dispatches notifications without sending any response', async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.connection.onNotification('note', (params) => seen.push(params));
    h.send({ jsonrpc: '2.0', method: 'note', params: { a: 1 } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([{ a: 1 }]);
    expect(h.received).toEqual([]);
  });

  it('responds MethodNotFound for an unregistered request method', async () => {
    const h = harness();
    h.send({ jsonrpc: '2.0', id: 2, method: 'does/not/exist' });
    const response = await h.waitFor((m) => m.id === 2);
    expect(response.error?.code).toBe(ErrorCodes.MethodNotFound);
  });

  it('silently ignores an unregistered notification method', async () => {
    const h = harness();
    h.send({ jsonrpc: '2.0', method: 'unknown/notification' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.received).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('turns a thrown ResponseErrorException into a matching error response', async () => {
    const h = harness();
    h.connection.onRequest('bad', () => {
      throw new ResponseErrorException(ErrorCodes.InvalidParams, 'nope', { detail: 'why' });
    });
    h.send({ jsonrpc: '2.0', id: 3, method: 'bad' });
    const response = await h.waitFor((m) => m.id === 3);
    expect(response.error).toEqual({
      code: ErrorCodes.InvalidParams,
      message: 'nope',
      data: { detail: 'why' },
    });
  });

  it('wraps an unexpected throw as InternalError and reports it via onError', async () => {
    const h = harness();
    h.connection.onRequest('boom', () => {
      throw new Error('kaboom');
    });
    h.send({ jsonrpc: '2.0', id: 4, method: 'boom' });
    const response = await h.waitFor((m) => m.id === 4);
    expect(response.error?.code).toBe(ErrorCodes.InternalError);
    expect(h.errors).toHaveLength(1);
  });

  it('reports a malformed incoming message via onError without crashing later dispatch', async () => {
    const h = harness();
    h.connection.onRequest('ping', () => 'pong');
    // A JSON-RPC-shaped-but-invalid object (no method, no id/result/error).
    h.send({ jsonrpc: '2.0', foo: 'bar' });
    h.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    const response = await h.waitFor((m) => m.id === 5);
    expect(response.result).toBe('pong');
    expect(h.errors.length).toBeGreaterThan(0);
  });

  it('cancels an in-flight request on $/cancelRequest and responds RequestCancelled', async () => {
    const h = harness();
    let cancellationSeen = false;
    h.connection.onRequest(
      'slow',
      (_params, token) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => {
            cancellationSeen = true;
            resolve('too-late');
          });
        }),
    );
    h.send({ jsonrpc: '2.0', id: 6, method: 'slow' });
    await new Promise((resolve) => setImmediate(resolve));
    h.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 6 } });
    const response = await h.waitFor((m) => m.id === 6);
    expect(cancellationSeen).toBe(true);
    expect(response.error?.code).toBe(ErrorCodes.RequestCancelled);
  });

  it('cancelling an already-completed request is a harmless no-op', async () => {
    const h = harness();
    h.connection.onRequest('fast', () => 'done');
    h.send({ jsonrpc: '2.0', id: 7, method: 'fast' });
    await h.waitFor((m) => m.id === 7);
    h.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 7 } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.errors).toEqual([]);
  });

  it('sendNotification writes a correctly framed outgoing notification', async () => {
    const h = harness();
    h.connection.sendNotification('server/note', { x: 1 });
    const note = await h.waitFor((m) => m.method === 'server/note');
    expect(note.params).toEqual({ x: 1 });
    expect(note.id).toBeUndefined();
  });

  it('sendRequest resolves once a matching response arrives', async () => {
    const h = harness();
    const promise = h.connection.sendRequest<string>('client/req', { y: 2 });
    const request = await h.waitFor((m) => m.method === 'client/req');
    expect(request.params).toEqual({ y: 2 });
    h.send({ jsonrpc: '2.0', id: request.id, result: 'ok' });
    await expect(promise).resolves.toBe('ok');
  });

  it('sendRequest rejects when the response carries an error', async () => {
    const h = harness();
    const promise = h.connection.sendRequest('client/req2');
    const request = await h.waitFor((m) => m.method === 'client/req2');
    h.send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: ErrorCodes.InternalError, message: 'boom' },
    });
    await expect(promise).rejects.toMatchObject({
      code: ErrorCodes.InternalError,
      message: 'boom',
    });
  });

  it('rejects outstanding sendRequest promises on dispose', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const connection = new MessageConnection({
      transport: { input: clientToServer, output: serverToClient },
    });
    connection.listen();
    const promise = connection.sendRequest('never/resolved');
    connection.dispose();
    await expect(promise).rejects.toThrow();
  });

  it('stops writing to the output after dispose', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const connection = new MessageConnection({
      transport: { input: clientToServer, output: serverToClient },
    });
    connection.listen();
    const chunks: Buffer[] = [];
    serverToClient.on('data', (c: Buffer) => chunks.push(c));
    connection.dispose();
    connection.sendNotification('after/dispose');
    await new Promise((resolve) => setImmediate(resolve));
    expect(chunks).toEqual([]);
  });
});
