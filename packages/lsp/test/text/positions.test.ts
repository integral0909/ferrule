import { SourceFile } from '@ferrule/script';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  comparePositions,
  containsPosition,
  offsetToPosition,
  positionToOffset,
  rangeToSpan,
  spanToRange,
  type Position,
} from '@ferrule/lsp';

/** An independent reference implementation, for the property test to check {@link offsetToPosition} against. */
function referencePosition(text: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10 /* '\n' */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

describe('offsetToPosition / positionToOffset', () => {
  it('agrees with a reference line/character count for every offset (property)', () => {
    const chunk = fc.oneof(
      fc.constant('\n'),
      fc.string({ unit: 'grapheme-ascii', minLength: 0, maxLength: 3 }),
      fc.constantFrom('😀', '🎉', 'é', '日', '🇸🇪'),
    );
    fc.assert(
      fc.property(fc.array(chunk, { maxLength: 25 }), (parts) => {
        const text = parts.join('');
        const file = new SourceFile('<test>', text);
        for (let offset = 0; offset <= text.length; offset++) {
          const position = offsetToPosition(file, offset);
          expect(position).toEqual(referencePosition(text, offset));
          expect(positionToOffset(file, position)).toBe(offset);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('treats an astral character as two UTF-16 code units, like JS string indexing', () => {
    const text = 'a😀b'; // 'a' (1 unit) + surrogate pair (2 units) + 'b' (1 unit) = 4 units
    expect(text.length).toBe(4);
    const file = new SourceFile('<test>', text);
    expect(offsetToPosition(file, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(file, 1)).toEqual({ line: 0, character: 1 });
    expect(offsetToPosition(file, 3)).toEqual({ line: 0, character: 3 });
    expect(offsetToPosition(file, 4)).toEqual({ line: 0, character: 4 });
    expect(positionToOffset(file, { line: 0, character: 1 })).toBe(1);
    expect(positionToOffset(file, { line: 0, character: 3 })).toBe(3);
  });

  it('finds the correct line for a position after one or more newlines', () => {
    const file = new SourceFile('<test>', 'abc\ndef\nghi');
    expect(offsetToPosition(file, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(file, 4)).toEqual({ line: 1, character: 0 });
    expect(offsetToPosition(file, 9)).toEqual({ line: 2, character: 1 });
    expect(positionToOffset(file, { line: 1, character: 2 })).toBe(6);
  });

  it('clamps an out-of-range line to the last line', () => {
    const file = new SourceFile('<test>', 'abc\ndef');
    expect(positionToOffset(file, { line: 99, character: 0 })).toBe(
      file.text.length - 'def'.length,
    );
    expect(positionToOffset(file, { line: 99, character: 99 })).toBe(file.text.length);
  });

  it('clamps an out-of-range character to the end of its line (excluding the newline)', () => {
    const file = new SourceFile('<test>', 'abc\ndef');
    expect(positionToOffset(file, { line: 0, character: 99 })).toBe(3);
  });

  it('clamps a negative line or character to zero', () => {
    const file = new SourceFile('<test>', 'abc\ndef');
    expect(positionToOffset(file, { line: -3, character: 0 })).toBe(0);
    expect(positionToOffset(file, { line: 0, character: -3 })).toBe(0);
  });
});

describe('spanToRange / rangeToSpan', () => {
  it('round-trips a span through a range', () => {
    const file = new SourceFile('<test>', 'hello\nworld\n');
    const span = { start: 2, end: 8 };
    expect(rangeToSpan(file, spanToRange(file, span))).toEqual(span);
  });
});

describe('comparePositions / containsPosition', () => {
  it('orders positions by line, then character', () => {
    expect(comparePositions({ line: 0, character: 5 }, { line: 1, character: 0 })).toBeLessThan(0);
    expect(comparePositions({ line: 2, character: 1 }, { line: 2, character: 3 })).toBeLessThan(0);
    expect(comparePositions({ line: 1, character: 1 }, { line: 1, character: 1 })).toBe(0);
  });

  it('treats a range as inclusive of its boundaries', () => {
    const range = { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } };
    expect(containsPosition(range, { line: 0, character: 2 })).toBe(true);
    expect(containsPosition(range, { line: 0, character: 5 })).toBe(true);
    expect(containsPosition(range, { line: 0, character: 1 })).toBe(false);
    expect(containsPosition(range, { line: 0, character: 6 })).toBe(false);
  });
});
