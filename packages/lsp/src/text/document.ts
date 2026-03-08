import { SourceFile } from '@ferrule/script';
import { offsetToPosition, positionToOffset, type Position, type Range } from './positions.js';

/** `textDocument/didChange`'s content change event: incremental (`range` set) or full replacement. */
export interface TextDocumentContentChangeEvent {
  readonly range?: Range;
  readonly rangeLength?: number;
  readonly text: string;
}

/**
 * A single open document: its URI, language id, version, and current text, kept as a
 * {@link SourceFile} so every other module can hand Ferrule Script spans straight to
 * {@link offsetToPosition}/{@link spanToRange} without re-deriving a line index.
 */
export class TextDocument {
  readonly uri: string;
  readonly languageId: string;
  private currentVersion: number;
  private currentSource: SourceFile;

  constructor(uri: string, languageId: string, version: number, text: string) {
    this.uri = uri;
    this.languageId = languageId;
    this.currentVersion = version;
    this.currentSource = new SourceFile(uri, text);
  }

  get version(): number {
    return this.currentVersion;
  }

  get text(): string {
    return this.currentSource.text;
  }

  /** The document's text, indexed for offset ⇄ line/column conversion and for `parse`/`check`. */
  get source(): SourceFile {
    return this.currentSource;
  }

  positionAt(offset: number): Position {
    return offsetToPosition(this.currentSource, offset);
  }

  offsetAt(position: Position): number {
    return positionToOffset(this.currentSource, position);
  }

  /**
   * Applies `didChange`'s content changes in order, each against the document state left by the
   * one before it (an incremental change's `range` is always relative to the *current* text, not
   * the original), then bumps the document to `version`.
   */
  applyChanges(version: number, changes: readonly TextDocumentContentChangeEvent[]): void {
    let text = this.currentSource.text;
    for (const change of changes) {
      if (change.range === undefined) {
        text = change.text;
        continue;
      }
      const source = new SourceFile(this.uri, text);
      const start = positionToOffset(source, change.range.start);
      const end = positionToOffset(source, change.range.end);
      text = text.slice(0, start) + change.text + text.slice(end);
    }
    this.currentSource = new SourceFile(this.uri, text);
    this.currentVersion = version;
  }
}

/** Tracks every open document by URI across `didOpen`/`didChange`/`didClose`. */
export class DocumentStore {
  private readonly documents = new Map<string, TextDocument>();

  open(uri: string, languageId: string, version: number, text: string): TextDocument {
    const document = new TextDocument(uri, languageId, version, text);
    this.documents.set(uri, document);
    return document;
  }

  change(
    uri: string,
    version: number,
    changes: readonly TextDocumentContentChangeEvent[],
  ): TextDocument | undefined {
    const document = this.documents.get(uri);
    if (document === undefined) return undefined;
    document.applyChanges(version, changes);
    return document;
  }

  close(uri: string): void {
    this.documents.delete(uri);
  }

  get(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  all(): readonly TextDocument[] {
    return [...this.documents.values()];
  }
}
