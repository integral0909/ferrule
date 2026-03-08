import type { SourceFile, Span } from '@ferrule/script';

/**
 * UTF-16 ⇄ {@link SourceFile} offset conversion. LSP positions count UTF-16 code units from the
 * start of a (zero-based) line — the same unit JavaScript strings are already indexed in, and the
 * same unit {@link SourceFile}'s offsets use (see `Span`'s doc comment in `@ferrule/script`). An
 * astral character (one outside the Basic Multilingual Plane, e.g. most emoji) is represented as a
 * UTF-16 surrogate pair — two code units — in *both* representations, so no code-point-counting
 * translation step is needed here; the risk this module guards against is accidentally reaching
 * for a code-point-based API (`Array.from`, `[...text]`, `String.prototype.codePointAt` loops) or
 * a byte-based one (`Buffer.byteLength`) instead of plain UTF-16 index arithmetic.
 */

/** A zero-based line/character position, in UTF-16 code units — `textDocument/*`'s `Position`. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** Converts a {@link SourceFile} offset to a zero-based LSP {@link Position}. */
export function offsetToPosition(file: SourceFile, offset: number): Position {
  const lineColumn = file.lineColumnAt(offset);
  return { line: lineColumn.line - 1, character: lineColumn.column - 1 };
}

/**
 * Converts a zero-based LSP {@link Position} to a {@link SourceFile} offset. Out-of-range lines
 * clamp to the first/last line; a character past the end of its line clamps to the line's length
 * (excluding its terminating newline) — the behavior the LSP spec asks servers to tolerate from
 * clients that computed a position against a slightly different version of the document.
 */
export function positionToOffset(file: SourceFile, position: Position): number {
  const line = Math.max(1, Math.min(position.line + 1, file.lineCount));
  const lineStart = file.lineStart(line);
  const maxCharacter = file.lineEnd(line) - lineStart;
  const character = Math.max(0, Math.min(position.character, maxCharacter));
  return lineStart + character;
}

export function spanToRange(file: SourceFile, span: Span): Range {
  return { start: offsetToPosition(file, span.start), end: offsetToPosition(file, span.end) };
}

export function rangeToSpan(file: SourceFile, range: Range): Span {
  return { start: positionToOffset(file, range.start), end: positionToOffset(file, range.end) };
}

/** `< 0` if `a` is before `b`, `0` if equal, `> 0` if `a` is after `b`. */
export function comparePositions(a: Position, b: Position): number {
  return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

export function containsPosition(range: Range, position: Position): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

/** A single point range, e.g. for a diagnostic or hover anchored at a position with no extent. */
export function pointRange(position: Position): Range {
  return { start: position, end: position };
}
