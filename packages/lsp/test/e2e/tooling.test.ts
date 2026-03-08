import { format } from '@ferrule/script';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CodeAction,
  DocumentSymbol,
  LspDiagnostic,
  SemanticTokens,
  TextEdit,
} from '@ferrule/lsp';
import { createTestServer, openDocument, type TestServer } from './helpers.js';

async function setup(client: TestServer): Promise<void> {
  await client.sendRequest('initialize', {});
  client.sendNotification('initialized', {});
}

describe('formatting', () => {
  let client: TestServer;
  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
  });
  afterEach(() => client.dispose());

  it('returns a single full-document edit matching the canonical formatter output', async () => {
    const uri = 'file:///fmt.fer';
    const text = 'let x=1\n.result=x\n';
    await openDocument(client, uri, text);
    const edits = await client.sendRequest<TextEdit[]>('textDocument/formatting', {
      textDocument: { uri },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.newText).toBe(format(text));
    expect(edits[0]?.range.start).toEqual({ line: 0, character: 0 });
  });

  it('returns no edits for text that is already canonically formatted', async () => {
    const uri = 'file:///fmt-clean.fer';
    const text = format('let x=1\n.result=x\n');
    await openDocument(client, uri, text);
    const edits = await client.sendRequest<TextEdit[]>('textDocument/formatting', {
      textDocument: { uri },
    });
    expect(edits).toEqual([]);
  });
});

describe('codeAction', () => {
  let client: TestServer;
  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
  });
  afterEach(() => client.dispose());

  it("offers the checker's suggested fixes for an unhandled-fallible diagnostic", async () => {
    const uri = 'file:///codeaction.fer';
    const text = 'let name = upcase(.user)\n.result = name\n';
    const diagnosticsNotification = await openDocument(client, uri, text);
    const diagnostics = (diagnosticsNotification.params as { diagnostics: LspDiagnostic[] })
      .diagnostics;
    const target = diagnostics.find((d) => d.code === 'E401');
    expect(target).toBeDefined();

    const actions = await client.sendRequest<CodeAction[]>('textDocument/codeAction', {
      textDocument: { uri },
      range: target!.range,
      context: { diagnostics: [target] },
    });
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.some((a) => a.title.includes('??'))).toBe(true);
    expect(actions.some((a) => a.title.includes('!'))).toBe(true);
    for (const action of actions) {
      expect(action.kind).toBe('quickfix');
      expect(action.edit.changes?.[uri]).toBeDefined();
    }
  });

  it('returns no actions when the diagnostic range does not overlap the requested range', async () => {
    const uri = 'file:///codeaction-none.fer';
    const text = 'let name = upcase(.user)\n.result = name\n';
    const diagnosticsNotification = await openDocument(client, uri, text);
    const diagnostics = (diagnosticsNotification.params as { diagnostics: LspDiagnostic[] })
      .diagnostics;
    const target = diagnostics.find((d) => d.code === 'E401')!;

    const actions = await client.sendRequest<CodeAction[]>('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } },
      context: { diagnostics: [target] },
    });
    expect(actions).toEqual([]);
  });
});

describe('documentSymbol', () => {
  let client: TestServer;
  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
  });
  afterEach(() => client.dispose());

  it('lists every let binding and test declaration', async () => {
    const uri = 'file:///symbols.fer';
    const text = [
      'let level = "info"',
      '.level = level',
      '',
      'test "keeps level" {',
      '  given { "level": "warn" }',
      '  expect { "level": "warn" }',
      '}',
      '',
    ].join('\n');
    await openDocument(client, uri, text);

    const symbols = await client.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    expect(symbols.map((s) => s.name)).toEqual(['level', 'keeps level']);
    expect(symbols[0]?.kind).toBe(13); // Variable
    expect(symbols[1]?.kind).toBe(12); // Function (used for `test` blocks)
  });
});

describe('semanticTokens/full', () => {
  let client: TestServer;
  let legend: { tokenTypes: string[]; tokenModifiers: string[] };

  beforeEach(async () => {
    client = createTestServer();
    const init = await client.sendRequest<{
      capabilities: { semanticTokensProvider: { legend: typeof legend } };
    }>('initialize', {});
    legend = init.capabilities.semanticTokensProvider.legend;
  });
  afterEach(() => client.dispose());

  it('classifies keywords, declarations, references, and function calls', async () => {
    const uri = 'file:///tokens.fer';
    const text = 'let name = upcase(.user) ?? "x"\n.result = name\n';
    await openDocument(client, uri, text);

    const tokens = await client.sendRequest<SemanticTokens>('textDocument/semanticTokens/full', {
      textDocument: { uri },
    });
    const decoded = decodeTokens(tokens.data, legend, text);

    const letKeyword = decoded.find((t) => t.text === 'let');
    expect(letKeyword?.type).toBe('keyword');

    const nameDecl = decoded.find((t) => t.text === 'name' && t.modifiers.includes('declaration'));
    expect(nameDecl?.type).toBe('variable');

    const nameRef = decoded.find((t) => t.text === 'name' && !t.modifiers.includes('declaration'));
    expect(nameRef?.type).toBe('variable');

    const upcaseCall = decoded.find((t) => t.text === 'upcase');
    expect(upcaseCall?.type).toBe('function');
  });

  it('produces tokens in strictly increasing document order (valid delta encoding)', async () => {
    const uri = 'file:///tokens-order.fer';
    const text = 'let a = 1\nlet b = a + 1\n.result = b\n';
    await openDocument(client, uri, text);
    const tokens = await client.sendRequest<SemanticTokens>('textDocument/semanticTokens/full', {
      textDocument: { uri },
    });
    expect(tokens.data.length % 5).toBe(0);
    const decoded = decodeTokens(tokens.data, legend, text);
    for (let i = 1; i < decoded.length; i++) {
      const prev = decoded[i - 1]!;
      const cur = decoded[i]!;
      expect(cur.line > prev.line || (cur.line === prev.line && cur.char >= prev.char)).toBe(true);
    }
  });
});

interface DecodedToken {
  readonly line: number;
  readonly char: number;
  readonly length: number;
  readonly type: string;
  readonly modifiers: readonly string[];
  readonly text: string;
}

function decodeTokens(
  data: readonly number[],
  legend: { tokenTypes: string[]; tokenModifiers: string[] },
  source: string,
): DecodedToken[] {
  const lines = source.split('\n');
  const tokens: DecodedToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    const deltaLine = data[i]!;
    const deltaChar = data[i + 1]!;
    const length = data[i + 2]!;
    const typeIndex = data[i + 3]!;
    const modifierBits = data[i + 4]!;
    line += deltaLine;
    char = deltaLine === 0 ? char + deltaChar : deltaChar;
    const modifiers = legend.tokenModifiers.filter((_, bit) => (modifierBits & (1 << bit)) !== 0);
    const text = (lines[line] ?? '').slice(char, char + length);
    tokens.push({ line, char, length, type: legend.tokenTypes[typeIndex]!, modifiers, text });
  }
  return tokens;
}
