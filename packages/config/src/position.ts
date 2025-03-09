/**
 * Source positions shared by the YAML parser, the JSON reader, and diagnostics rendering.
 * Every value produced by a loader carries a {@link Range} so schema issues can be reported at
 * the exact line and column that caused them.
 */

/** A single point in a source document. `line` and `column` are 1-based. */
export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** A half-open span `[start, end)` in a source document. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** A range together with the file it belongs to, used once documents are merged. */
export interface SourceLocation {
  readonly file: string;
  readonly range: Range;
}

/** Builds a zero-width range at `position`, used when no better span is available. */
export function pointRange(position: Position): Range {
  return { start: position, end: position };
}

/** The union of two ranges from the same document: the smallest range containing both. */
export function spanRanges(a: Range, b: Range): Range {
  const start = a.start.offset <= b.start.offset ? a.start : b.start;
  const end = a.end.offset >= b.end.offset ? a.end : b.end;
  return { start, end };
}

/**
 * Computes line/column tables for `text` once, so repeated offset lookups (one per token) are
 * O(log n) instead of O(n). Lines are split on `\n`; a trailing `\r` is treated as part of the
 * line's content width but does not start a new line.
 */
export class LineIndex {
  /** Offsets of the start of each line, line 0 first. */
  private readonly lineStarts: number[];

  constructor(readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x0a) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= clamped) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.lineStarts[lo]!;
    return { offset: clamped, line: lo + 1, column: clamped - lineStart + 1 };
  }

  rangeAt(startOffset: number, endOffset: number): Range {
    return { start: this.positionAt(startOffset), end: this.positionAt(endOffset) };
  }

  /** The 0-based line's raw text, without its terminator. */
  lineText(lineNumber1Based: number): string {
    const idx = lineNumber1Based - 1;
    const start = this.lineStarts[idx];
    if (start === undefined) return '';
    const end = this.lineStarts[idx + 1];
    const raw = end === undefined ? this.text.slice(start) : this.text.slice(start, end);
    return raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}
