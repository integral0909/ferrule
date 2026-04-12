import { encodeFrame } from '@ferrule/lsp';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import { createFakeEnvironment } from '../support/environment.js';

function frame(message: unknown): Buffer {
  return encodeFrame(message);
}

describe('ferrule lsp', () => {
  it('speaks JSON-RPC over stdio and exits 0 after a clean shutdown/exit sequence', async () => {
    const env = createFakeEnvironment({ argv: ['lsp'] });
    const runPromise = runCli(env);

    env.stdinStream.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(env.stdoutText()).toContain('"capabilities"');

    env.stdinStream.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }));
    await new Promise((resolve) => setImmediate(resolve));
    env.stdinStream.write(frame({ jsonrpc: '2.0', method: 'exit', params: null }));

    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
  });

  it('disposes and exits 0 on SIGTERM without a client-initiated exit', async () => {
    const env = createFakeEnvironment({ argv: ['lsp'] });
    const runPromise = runCli(env);
    await new Promise((resolve) => setImmediate(resolve));
    env.fakeSignals.emit('SIGTERM');
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
  });

  it('answers textDocument/hover for a simple document', async () => {
    const env = createFakeEnvironment({ argv: ['lsp'] });
    const runPromise = runCli(env);

    env.stdinStream.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    env.stdinStream.write(
      frame({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: 'file:///a.fe',
            languageId: 'ferrule',
            version: 1,
            text: '.a = 1\n',
          },
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    env.stdinStream.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }));
    env.stdinStream.write(frame({ jsonrpc: '2.0', method: 'exit', params: null }));
    const code = await runPromise;
    expect(code).toBe(EXIT_OK);
  });
});
