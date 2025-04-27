/**
 * A source span: a half-open range `[start, end)` of UTF-16 code unit offsets into a
 * {@link SourceFile}'s text. Every syntax and diagnostic node carries one.
 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A span that points at nothing in particular, e.g. for synthesized nodes. */
export const EMPTY_SPAN: Span = { start: 0, end: 0 };

/** Returns a span covering both `a` and `b`. */
export function joinSpans(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

/** A 1-based line and column (column counts UTF-16 code units, like the offsets themselves). */
export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/**
 * Source text plus a name (typically a file path or `<repl>`), with an index for translating
 * between byte offsets and line/column positions.
 */
export class SourceFile {
  readonly name: string;
  readonly text: string;
  private readonly lineStarts: readonly number[];

  constructor(name: string, text: string) {
    this.name = name;
    this.text = text;
    this.lineStarts = computeLineStarts(text);
  }

  /** Converts an offset into a 1-based line/column. Offsets past the end clamp to the last position. */
  lineColumnAt(offset: number): LineColumn {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    const lineStart = this.lineStarts[low]!;
    return { line: low + 1, column: clamped - lineStart + 1 };
  }

  /** The 1-based line number containing `offset`. */
  lineAt(offset: number): number {
    return this.lineColumnAt(offset).line;
  }

  /** The offset of the start of `line` (1-based). */
  lineStart(line: number): number {
    const idx = Math.max(0, Math.min(line - 1, this.lineStarts.length - 1));
    return this.lineStarts[idx]!;
  }

  /** The offset just past the end of `line` (1-based), excluding its terminating newline. */
  lineEnd(line: number): number {
    const idx = Math.max(0, Math.min(line - 1, this.lineStarts.length - 1));
    const next = idx + 1 < this.lineStarts.length ? this.lineStarts[idx + 1]! : this.text.length;
    let end = next;
    if (end > this.lineStarts[idx]! && this.text.charCodeAt(end - 1) === 10) end--;
    if (end > this.lineStarts[idx]! && this.text.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  /** The total number of lines (at least 1, even for empty text). */
  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** The raw text of `line` (1-based), without its terminating newline. */
  lineText(line: number): string {
    return this.text.slice(this.lineStart(line), this.lineEnd(line));
  }

  /** The text covered by `span`. */
  textOf(span: Span): string {
    return this.text.slice(span.start, span.end);
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      starts.push(i + 1);
    } else if (c === 13) {
      if (text.charCodeAt(i + 1) !== 10) starts.push(i + 1);
    }
  }
  return starts;
}
