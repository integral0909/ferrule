import {
  check,
  parse,
  type CheckResult,
  type Diagnostic,
  type FunctionRegistry,
  type ParseResult,
} from '@ferrule/script';
import type { TextDocument } from './text/document.js';

/** The parse + check result for one document version — everything a feature needs to answer a request. */
export interface DocumentAnalysis {
  readonly document: TextDocument;
  readonly version: number;
  readonly parseResult: ParseResult;
  readonly checkResult: CheckResult;
  /** Parse and check diagnostics merged, in source order. */
  readonly diagnostics: readonly Diagnostic[];
}

export function analyzeDocument(
  document: TextDocument,
  registry: FunctionRegistry,
): DocumentAnalysis {
  const parseResult = parse(document.source);
  const checkResult = check(parseResult.program, { registry });
  return {
    document,
    version: document.version,
    parseResult,
    checkResult,
    diagnostics: [...parseResult.diagnostics, ...checkResult.diagnostics],
  };
}

/**
 * Caches the most recent {@link DocumentAnalysis} per document URI, keyed by version, so that
 * (say) a `hover` request right after `publishDiagnostics` doesn't re-parse and re-check the same
 * text. A version bump (from any `didChange`) invalidates the entry naturally, since the cached
 * entry's `version` no longer matches.
 */
export class AnalysisCache {
  private readonly registry: FunctionRegistry;
  private readonly cache = new Map<string, DocumentAnalysis>();

  constructor(registry: FunctionRegistry) {
    this.registry = registry;
  }

  get(document: TextDocument): DocumentAnalysis {
    const cached = this.cache.get(document.uri);
    if (cached !== undefined && cached.version === document.version) return cached;
    const analysis = analyzeDocument(document, this.registry);
    this.cache.set(document.uri, analysis);
    return analysis;
  }

  invalidate(uri: string): void {
    this.cache.delete(uri);
  }
}
