import { createDefaultRegistry } from '@ferrule/script';
import { describe, expect, it } from 'vitest';
import { AnalysisCache, analyzeDocument, TextDocument } from '@ferrule/lsp';

describe('analyzeDocument', () => {
  it('merges parse and check diagnostics, parse diagnostics first', () => {
    const registry = createDefaultRegistry();
    // An unterminated string is a lexer/parse-level error (E001); the unhandled `upcase(...)`
    // call on the next line is a checker error (E401).
    const document = new TextDocument(
      'file:///a.fer',
      'ferrule',
      1,
      'let bad = "unterminated\nlet x = upcase(.user)\n',
    );
    const analysis = analyzeDocument(document, registry);
    expect(analysis.diagnostics).toEqual([
      ...analysis.parseResult.diagnostics,
      ...analysis.checkResult.diagnostics,
    ]);
    expect(analysis.parseResult.diagnostics.some((d) => d.code === 'E001')).toBe(true);
    expect(analysis.checkResult.diagnostics.some((d) => d.code === 'E401')).toBe(true);
  });

  it("exposes the checked program's types map for hover/completion to use", () => {
    const registry = createDefaultRegistry();
    const document = new TextDocument('file:///b.fer', 'ferrule', 1, 'let x = 1\n.result = x\n');
    const analysis = analyzeDocument(document, registry);
    expect(analysis.checkResult.types.size).toBeGreaterThan(0);
  });
});

describe('AnalysisCache', () => {
  it('returns the same analysis object for repeated calls at the same version', () => {
    const cache = new AnalysisCache(createDefaultRegistry());
    const document = new TextDocument('file:///a.fer', 'ferrule', 1, 'let x = 1\n.result = x\n');
    const first = cache.get(document);
    const second = cache.get(document);
    expect(second).toBe(first);
  });

  it('recomputes once the document version changes', () => {
    const cache = new AnalysisCache(createDefaultRegistry());
    const document = new TextDocument('file:///a.fer', 'ferrule', 1, 'let x = 1\n.result = x\n');
    const first = cache.get(document);
    document.applyChanges(2, [{ text: 'let y = 2\n.result = y\n' }]);
    const second = cache.get(document);
    expect(second).not.toBe(first);
    expect(second.version).toBe(2);
  });

  it('invalidate forces the next get() to recompute even at the same version', () => {
    const cache = new AnalysisCache(createDefaultRegistry());
    const document = new TextDocument('file:///a.fer', 'ferrule', 1, 'let x = 1\n.result = x\n');
    const first = cache.get(document);
    cache.invalidate(document.uri);
    const second = cache.get(document);
    expect(second).not.toBe(first);
    expect(second.version).toBe(first.version);
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it('keeps separate cache entries per document uri', () => {
    const cache = new AnalysisCache(createDefaultRegistry());
    const a = new TextDocument('file:///a.fer', 'ferrule', 1, 'let x = 1\n.result = x\n');
    const b = new TextDocument('file:///b.fer', 'ferrule', 1, 'let y = 2\n.result = y\n');
    const analysisA = cache.get(a);
    const analysisB = cache.get(b);
    expect(analysisA.document.uri).toBe('file:///a.fer');
    expect(analysisB.document.uri).toBe('file:///b.fer');
    expect(cache.get(a)).toBe(analysisA);
  });
});
