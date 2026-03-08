import { describe, expect, it } from 'vitest';
import { DocumentStore, TextDocument } from '@ferrule/lsp';

describe('TextDocument', () => {
  it('tracks uri, languageId, version and text', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, '.a = 1');
    expect(doc.uri).toBe('file:///a.fer');
    expect(doc.languageId).toBe('ferrule');
    expect(doc.version).toBe(1);
    expect(doc.text).toBe('.a = 1');
  });

  it('applies a full-document replacement when no range is given', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, 'old text');
    doc.applyChanges(2, [{ text: 'brand new text' }]);
    expect(doc.text).toBe('brand new text');
    expect(doc.version).toBe(2);
  });

  it('applies a single incremental range replacement', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, 'let x = 1\nlet y = 2');
    // Replace "1" on line 0 with "100".
    doc.applyChanges(2, [
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } }, text: '100' },
    ]);
    expect(doc.text).toBe('let x = 100\nlet y = 2');
  });

  it('applies several incremental changes in order, each against the previous result', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, 'abcdef');
    doc.applyChanges(2, [
      // Insert "XX" after "ab" -> "abXXcdef"
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, text: 'XX' },
      // Now delete "XX" (now at offset 2..4) -> back to "abcdef"
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, text: '' },
      // Append "!" at the end (offset 6, still valid since we're back to "abcdef")
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } }, text: '!' },
    ]);
    expect(doc.text).toBe('abcdef!');
  });

  it('applies a multi-line range replacement', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, 'line one\nline two\nline three');
    doc.applyChanges(2, [
      {
        range: { start: { line: 0, character: 5 }, end: { line: 1, character: 4 } },
        text: 'REPLACED',
      },
    ]);
    expect(doc.text).toBe('line REPLACED two\nline three');
  });

  it('positionAt / offsetAt round-trip through the current text', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, 'abc\ndefg\nhi');
    for (let offset = 0; offset <= doc.text.length; offset++) {
      expect(doc.offsetAt(doc.positionAt(offset))).toBe(offset);
    }
  });

  it('reflects new content in positionAt/offsetAt after a change', () => {
    const doc = new TextDocument('file:///a.fer', 'ferrule', 1, 'abc');
    doc.applyChanges(2, [{ text: 'abc\ndef' }]);
    expect(doc.positionAt(4)).toEqual({ line: 1, character: 0 });
  });
});

describe('DocumentStore', () => {
  it('opens, retrieves, changes, and closes documents by uri', () => {
    const store = new DocumentStore();
    const uri = 'file:///doc.fer';
    store.open(uri, 'ferrule', 1, 'initial');
    expect(store.get(uri)?.text).toBe('initial');

    const changed = store.change(uri, 2, [{ text: 'updated' }]);
    expect(changed?.text).toBe('updated');
    expect(store.get(uri)?.version).toBe(2);

    store.close(uri);
    expect(store.get(uri)).toBeUndefined();
  });

  it('change on an unknown uri returns undefined without throwing', () => {
    const store = new DocumentStore();
    expect(store.change('file:///missing.fer', 2, [{ text: 'x' }])).toBeUndefined();
  });

  it('all() lists every currently open document', () => {
    const store = new DocumentStore();
    store.open('file:///a.fer', 'ferrule', 1, 'a');
    store.open('file:///b.fer', 'ferrule', 1, 'b');
    expect(
      store
        .all()
        .map((d) => d.uri)
        .sort(),
    ).toEqual(['file:///a.fer', 'file:///b.fer']);
  });
});
