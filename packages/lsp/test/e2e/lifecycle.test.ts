import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, openDocument, type TestServer } from './helpers.js';

describe('lifecycle', () => {
  let client: TestServer;

  afterEach(() => {
    client?.dispose();
  });

  it('initialize advertises the capabilities this server actually implements', async () => {
    client = createTestServer();
    const result = await client.sendRequest<{
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
    }>('initialize', { processId: null, rootUri: null, capabilities: {} });

    expect(result.serverInfo.name).toBe('ferrule-lsp');
    const capabilities = result.capabilities;
    expect(capabilities['positionEncoding']).toBe('utf-16');
    expect(capabilities['hoverProvider']).toBe(true);
    expect(capabilities['definitionProvider']).toBe(true);
    expect(capabilities['referencesProvider']).toBe(true);
    expect(capabilities['documentHighlightProvider']).toBe(true);
    expect(capabilities['renameProvider']).toBe(true);
    expect(capabilities['documentFormattingProvider']).toBe(true);
    expect(capabilities['codeActionProvider']).toBe(true);
    expect(capabilities['documentSymbolProvider']).toBe(true);
    expect(capabilities['textDocumentSync']).toEqual({ openClose: true, change: 2 });
    const completionProvider = capabilities['completionProvider'] as {
      triggerCharacters: string[];
    };
    expect(completionProvider.triggerCharacters).toContain('.');
    expect(completionProvider.triggerCharacters).toContain('%');
    const signatureHelpProvider = capabilities['signatureHelpProvider'] as {
      triggerCharacters: string[];
    };
    expect(signatureHelpProvider.triggerCharacters).toContain('(');
    const semanticTokens = capabilities['semanticTokensProvider'] as {
      legend: { tokenTypes: string[]; tokenModifiers: string[] };
      full: boolean;
    };
    expect(semanticTokens.full).toBe(true);
    expect(semanticTokens.legend.tokenTypes).toEqual(
      expect.arrayContaining(['keyword', 'variable', 'function']),
    );
  });

  it('initialized is accepted as a no-op notification', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    client.sendNotification('initialized', {});
    // Should not blow up or produce any spurious message; a follow-up request still works.
    const hover = await client.sendRequest('textDocument/hover', {
      textDocument: { uri: 'file:///missing.fer' },
      position: { line: 0, character: 0 },
    });
    expect(hover).toBeNull();
  });

  it('shutdown returns null, and exit afterward reports exit code 0', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    const shutdownResult = await client.sendRequest('shutdown');
    expect(shutdownResult).toBeNull();
    client.sendNotification('exit');
    await client.waitFor(() => client.exitCodes.length > 0);
    expect(client.exitCodes).toEqual([0]);
  });

  it('exit without a prior shutdown reports exit code 1', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    client.sendNotification('exit');
    await client.waitFor(() => client.exitCodes.length > 0);
    expect(client.exitCodes).toEqual([1]);
  });

  it('didOpen publishes diagnostics for the opened document', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    const notification = await openDocument(client, 'file:///open.fer', 'let x = upcase(.user)\n');
    const params = notification.params as {
      uri: string;
      diagnostics: readonly { code: string; severity: number }[];
    };
    expect(params.uri).toBe('file:///open.fer');
    expect(params.diagnostics.some((d) => d.code === 'E401')).toBe(true);
    expect(params.diagnostics[0]?.severity).toBe(1);
  });

  it('a clean document publishes an empty diagnostics array', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    const notification = await openDocument(
      client,
      'file:///clean.fer',
      'let x = upcase(.user) ?? "unknown"\n.result = x\n',
    );
    const params = notification.params as { diagnostics: readonly unknown[] };
    expect(params.diagnostics).toEqual([]);
  });

  it('didChange debounces diagnostics through the injected scheduler until flushed', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    await openDocument(client, 'file:///change.fer', 'let x = 1\n');

    const beforeCount = client.received.filter(
      (m) => m.method === 'textDocument/publishDiagnostics',
    ).length;
    client.sendNotification('textDocument/didChange', {
      textDocument: { uri: 'file:///change.fer', version: 2 },
      contentChanges: [{ text: 'let y = undefined_name\n' }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing published yet: the scheduler hasn't been flushed.
    const afterScheduleCount = client.received.filter(
      (m) => m.method === 'textDocument/publishDiagnostics',
    ).length;
    expect(afterScheduleCount).toBe(beforeCount);
    expect(client.scheduler.pendingKeys).toContain('file:///change.fer');

    client.scheduler.flush();
    const notification = await client.waitFor(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' &&
        (m.params as { uri: string }).uri === 'file:///change.fer' &&
        (m.params as { diagnostics: readonly { code: string }[] }).diagnostics.some(
          (d) => d.code === 'E201',
        ),
    );
    const params = notification.params as {
      version: number;
      diagnostics: readonly { code: string }[];
    };
    expect(params.version).toBe(2);
    expect(params.diagnostics.some((d) => d.code === 'E201')).toBe(true);
  });

  it('didClose clears diagnostics for that document', async () => {
    client = createTestServer();
    await client.sendRequest('initialize', {});
    await openDocument(client, 'file:///close.fer', 'let x = upcase(.user)\n');

    client.sendNotification('textDocument/didClose', {
      textDocument: { uri: 'file:///close.fer' },
    });
    const cleared = await client.waitFor(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' &&
        (m.params as { uri: string }).uri === 'file:///close.fer' &&
        (m.params as { diagnostics: readonly unknown[] }).diagnostics.length === 0,
    );
    expect((cleared.params as { diagnostics: readonly unknown[] }).diagnostics).toEqual([]);
  });
});
