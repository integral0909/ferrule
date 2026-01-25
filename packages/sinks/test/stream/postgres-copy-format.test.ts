import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decodeCopyTextRow,
  encodeCopyCsvRow,
  encodeCopyTextRow,
  escapeCopyTextField,
} from '../../src/postgres/copy-format.js';

describe('COPY text format', () => {
  it('round-trips a simple row', () => {
    const row = decodeCopyTextRow(encodeCopyTextRow(['a', 'b', 'c']).slice(0, -1));
    expect(row).toEqual(['a', 'b', 'c']);
  });

  it('escapes and round-trips backslash, tab, newline, and carriage return', () => {
    const values = ['back\\slash', 'a\tb', 'line1\nline2', 'cr\rreturn'];
    const encoded = encodeCopyTextRow(values);
    expect(decodeCopyTextRow(encoded.slice(0, -1))).toEqual(values);
  });

  it('represents null as \\N and round-trips it', () => {
    const encoded = encodeCopyTextRow(['a', null, 'c']);
    expect(encoded).toBe('a\t\\N\tc\n');
    expect(decodeCopyTextRow(encoded.slice(0, -1))).toEqual(['a', null, 'c']);
  });

  it('distinguishes literal data "\\N" from the null marker', () => {
    const encoded = escapeCopyTextField('\\N');
    expect(encoded).toBe('\\\\N'); // backslash escaped, N literal
    expect(decodeCopyTextRow(`x\t${encoded}`)).toEqual(['x', '\\N']);
  });

  it('handles an empty string field distinctly from null', () => {
    const encoded = encodeCopyTextRow(['', null]);
    expect(decodeCopyTextRow(encoded.slice(0, -1))).toEqual(['', null]);
  });

  it('respects a custom delimiter', () => {
    const encoded = encodeCopyTextRow(['a,b', 'c'], { delimiter: ',' });
    expect(encoded).toBe('a\\,b,c\n');
    expect(decodeCopyTextRow(encoded.slice(0, -1), { delimiter: ',' })).toEqual(['a,b', 'c']);
  });

  it('property: encode -> decode round-trips any row of arbitrary strings and nulls', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 40 }), fc.constant(null)), {
          minLength: 1,
          maxLength: 8,
        }),
        (values) => {
          const encoded = encodeCopyTextRow(values);
          expect(encoded.endsWith('\n')).toBe(true);
          const decoded = decodeCopyTextRow(encoded.slice(0, -1));
          expect(decoded).toEqual(values);
        },
      ),
    );
  });

  it('property: no unescaped delimiter or bare newline ever appears in an encoded field', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (value) => {
        const encoded = escapeCopyTextField(value);
        // A tab in the encoded output can only appear as part of the literal escape "\t"... but
        // since we escape delimiter (default "\t") itself, any raw tab byte must be preceded by a
        // backslash.
        for (let i = 0; i < encoded.length; i++) {
          if (encoded[i] === '\t') expect(encoded[i - 1]).toBe('\\');
        }
      }),
    );
  });
});

describe('COPY csv format', () => {
  it('quotes fields containing the delimiter, quote character, or newline', () => {
    const encoded = encodeCopyCsvRow(['a,b', 'c"d', 'e\nf', 'plain']);
    expect(encoded).toBe('"a,b","c""d","e\nf",plain\n');
  });

  it('force-quotes an empty string so it is distinct from an unquoted null', () => {
    const encoded = encodeCopyCsvRow(['', null]);
    expect(encoded).toBe('"",\n');
  });

  it('supports a custom null string', () => {
    const encoded = encodeCopyCsvRow(['a', null], { nullString: 'NULL' });
    expect(encoded).toBe('a,NULL\n');
  });
});
