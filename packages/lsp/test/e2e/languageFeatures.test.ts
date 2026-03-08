import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CompletionItem,
  CompletionList,
  Hover,
  Location,
  SignatureHelp,
  WorkspaceEdit,
} from '@ferrule/lsp';
import { createTestServer, openDocument, type TestServer } from './helpers.js';

async function setup(client: TestServer): Promise<void> {
  await client.sendRequest('initialize', {});
  client.sendNotification('initialized', {});
}

describe('hover', () => {
  let client: TestServer;
  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
  });
  afterEach(() => client.dispose());

  it('shows the resolved signature when hovering a function name', async () => {
    const uri = 'file:///hover-fn.fer';
    const text = 'let name = upcase(.user) ?? "unknown"\n.result = name\n';
    await openDocument(client, uri, text);
    const callOffset = text.indexOf('upcase') + 1;
    const position = offsetToLineChar(text, callOffset);

    const hover = await client.sendRequest<Hover>('textDocument/hover', {
      textDocument: { uri },
      position,
    });
    expect(hover).not.toBeNull();
    expect(hover?.contents.value).toContain('upcase');
    expect(hover?.contents.kind).toBe('markdown');
  });

  it("shows a variable binding's inferred type when hovering a reference", async () => {
    const uri = 'file:///hover-var.fer';
    const text = 'let name = upcase(.user) ?? "unknown"\n.result = name\n';
    await openDocument(client, uri, text);
    const useOffset = text.lastIndexOf('name');
    const position = offsetToLineChar(text, useOffset);

    const hover = await client.sendRequest<Hover>('textDocument/hover', {
      textDocument: { uri },
      position,
    });
    expect(hover?.contents.value).toContain('name');
    expect(hover?.contents.value).toContain('string');
  });

  it('returns null when hovering whitespace with nothing resolvable', async () => {
    const uri = 'file:///hover-empty.fer';
    const text = '\n\n';
    await openDocument(client, uri, text);
    const hover = await client.sendRequest<Hover>('textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });
    expect(hover).toBeNull();
  });
});

describe('completion', () => {
  let client: TestServer;
  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
  });
  afterEach(() => client.dispose());

  it('includes stdlib functions with snippet insert text and documentation', async () => {
    const uri = 'file:///completion-fn.fer';
    const text = 'let x = 1\n';
    await openDocument(client, uri, text);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 0 },
    });
    const upcase = list.items.find((i: CompletionItem) => i.label === 'upcase');
    expect(upcase).toBeDefined();
    expect(upcase?.insertTextFormat).toBe(2); // Snippet
    expect(upcase?.insertText).toContain('${');
    expect(upcase?.documentation?.value).toContain('upcase');
  });

  it('includes in-scope variables and keywords', async () => {
    const uri = 'file:///completion-var.fer';
    const text = 'let total = 1\n';
    await openDocument(client, uri, text);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 0 },
    });
    expect(list.items.some((i: CompletionItem) => i.label === 'total')).toBe(true);
    expect(list.items.some((i: CompletionItem) => i.label === 'let')).toBe(true);
    expect(list.items.some((i: CompletionItem) => i.label === 'if')).toBe(true);
  });

  it('does not offer a variable before its declaration', async () => {
    const uri = 'file:///completion-scope.fer';
    const text = 'let a = 1\n';
    await openDocument(client, uri, text);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 0, character: 4 }, // right at `a`'s own name, before it is bound
    });
    expect(list.items.some((i: CompletionItem) => i.label === 'a')).toBe(false);
  });

  it('offers field paths seen elsewhere in the document after a `.` trigger', async () => {
    const uri = 'file:///completion-path.fer';
    const text = '.status = "ok"\n.\n';
    await openDocument(client, uri, text);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 1 },
    });
    const item = list.items.find((i: CompletionItem) => i.label === '.status');
    expect(item).toBeDefined();
    // The replacement must cover the whole path token being typed (just "." here), not be
    // inserted at the cursor as plain text, or the result would read "..status".
    expect(item?.textEdit).toEqual({
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      newText: '.status',
    });
  });

  it('does not offer the path currently being typed as a completion of itself', async () => {
    const uri = 'file:///completion-path-self.fer';
    const text = '.status\n';
    await openDocument(client, uri, text);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 0, character: 7 },
    });
    expect(list.items.some((i: CompletionItem) => i.label === '.status')).toBe(false);
  });

  it('offers known metadata path names after a `%` trigger, replacing the whole token', async () => {
    const uri = 'file:///completion-metadata.fer';
    const text = '.src = %so\n';
    await openDocument(client, uri, text);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 0, character: 10 },
    });
    const item = list.items.find((i: CompletionItem) => i.label === '%source_id');
    expect(item).toBeDefined();
    expect(item?.textEdit?.newText).toBe('%source_id');
    expect(item?.textEdit?.range).toEqual({
      start: { line: 0, character: 7 },
      end: { line: 0, character: 10 },
    });
  });

  it("offers named parameters inside a call's argument list", async () => {
    const uri = 'file:///completion-named.fer';
    const text = 'let x = round(1.5, )\n.result = x\n';
    await openDocument(client, uri, text);
    const cursor = text.indexOf(')', text.indexOf('round'));
    const position = offsetToLineChar(text, cursor);
    const list = await client.sendRequest<CompletionList>('textDocument/completion', {
      textDocument: { uri },
      position,
    });
    expect(list.items.some((i: CompletionItem) => i.label === 'precision:')).toBe(true);
  });
});

describe('signatureHelp', () => {
  let client: TestServer;
  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
  });
  afterEach(() => client.dispose());

  it('reports the active parameter for the first positional argument', async () => {
    const uri = 'file:///sighelp.fer';
    const text = 'let x = upcase(\n.result = x\n';
    await openDocument(client, uri, text);
    const cursor = text.indexOf('upcase(') + 'upcase('.length;
    const position = offsetToLineChar(text, cursor);
    const help = await client.sendRequest<SignatureHelp | null>('textDocument/signatureHelp', {
      textDocument: { uri },
      position,
    });
    expect(help).not.toBeNull();
    expect(help?.signatures[0]?.label).toContain('upcase(');
    expect(help?.activeParameter).toBe(0);
  });

  it('reports the second parameter as active after a comma', async () => {
    const uri = 'file:///sighelp2.fer';
    const text = 'let x = join(.items, ", ")\n.result = x\n';
    await openDocument(client, uri, text);
    const cursor = text.indexOf(', ', text.indexOf('join(')) + 2;
    const position = offsetToLineChar(text, cursor);
    const help = await client.sendRequest<SignatureHelp | null>('textDocument/signatureHelp', {
      textDocument: { uri },
      position,
    });
    expect(help?.activeParameter).toBe(1);
  });

  it('returns null outside of any call', async () => {
    const uri = 'file:///sighelp3.fer';
    const text = 'let x = 1\n';
    await openDocument(client, uri, text);
    const help = await client.sendRequest('textDocument/signatureHelp', {
      textDocument: { uri },
      position: { line: 0, character: 4 },
    });
    expect(help).toBeNull();
  });
});

describe('definition / references / documentHighlight / rename', () => {
  let client: TestServer;
  const uri = 'file:///nav.fer';
  const text = 'let count = 1\nlet total = count + count\n';

  beforeEach(async () => {
    client = createTestServer();
    await setup(client);
    await openDocument(client, uri, text);
  });
  afterEach(() => client.dispose());

  it('goes to the declaration from a use', async () => {
    const secondUse = text.lastIndexOf('count');
    const location = await client.sendRequest<Location | null>('textDocument/definition', {
      textDocument: { uri },
      position: offsetToLineChar(text, secondUse),
    });
    expect(location).not.toBeNull();
    expect(location?.range.start).toEqual(offsetToLineChar(text, text.indexOf('count')));
  });

  it('finds every reference including the declaration when requested', async () => {
    const declOffset = text.indexOf('count');
    const locations = await client.sendRequest<Location[]>('textDocument/references', {
      textDocument: { uri },
      position: offsetToLineChar(text, declOffset),
      context: { includeDeclaration: true },
    });
    expect(locations).toHaveLength(3); // declaration + two uses in `count + count`
  });

  it('excludes the declaration when includeDeclaration is false', async () => {
    const declOffset = text.indexOf('count');
    const locations = await client.sendRequest<Location[]>('textDocument/references', {
      textDocument: { uri },
      position: offsetToLineChar(text, declOffset),
      context: { includeDeclaration: false },
    });
    expect(locations).toHaveLength(2);
  });

  it('documentHighlight marks the declaration and every read', async () => {
    const declOffset = text.indexOf('count');
    const highlights = await client.sendRequest<{ range: unknown; kind?: number }[]>(
      'textDocument/documentHighlight',
      { textDocument: { uri }, position: offsetToLineChar(text, declOffset) },
    );
    expect(highlights).toHaveLength(3);
  });

  it('renames every occurrence of the variable', async () => {
    const declOffset = text.indexOf('count');
    const edit = await client.sendRequest<WorkspaceEdit>('textDocument/rename', {
      textDocument: { uri },
      position: offsetToLineChar(text, declOffset),
      newName: 'counter',
    });
    const edits = edit.changes?.[uri] ?? [];
    expect(edits).toHaveLength(3);
    expect(edits.every((e) => e.newText === 'counter')).toBe(true);
  });

  it('rejects a rename to an invalid identifier', async () => {
    const declOffset = text.indexOf('count');
    await expect(
      client.sendRequest('textDocument/rename', {
        textDocument: { uri },
        position: offsetToLineChar(text, declOffset),
        newName: '1bad-name',
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects a rename that collides with an existing binding in the same scope', async () => {
    const declOffset = text.indexOf('count');
    await expect(
      client.sendRequest('textDocument/rename', {
        textDocument: { uri },
        position: offsetToLineChar(text, declOffset),
        newName: 'total',
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

/** Converts a plain offset into `text` to a zero-based LSP `{ line, character }` (ASCII-only helper for tests). */
function offsetToLineChar(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}
