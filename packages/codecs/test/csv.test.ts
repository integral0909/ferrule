import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LimitExceededError } from '@ferrule/core';
import {
  CsvParser,
  decodeCsvToLogEvents,
  encodeCsv,
  encodeLogEventsAsCsv,
  parseCsv,
  quoteCsvField,
} from '@ferrule/codecs';
import { LogEvent } from '@ferrule/core';

describe('parseCsv', () => {
  it('parses simple comma-separated rows', () => {
    const rows = parseCsv('a,b,c\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('parses quoted fields containing the delimiter', () => {
    const rows = parseCsv('"a,b",c\n');
    expect(rows).toEqual([['a,b', 'c']]);
  });

  it('parses an escaped quote ("") inside a quoted field', () => {
    const rows = parseCsv('"say ""hi""",ok\n');
    expect(rows).toEqual([['say "hi"', 'ok']]);
  });

  it('parses a quoted field containing an embedded newline', () => {
    const rows = parseCsv('"line1\nline2",b\n');
    expect(rows).toEqual([['line1\nline2', 'b']]);
  });

  it('accepts bare LF, bare CR, and CRLF row terminators', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles a final row with no trailing terminator', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('supports a custom delimiter', () => {
    expect(parseCsv('a;b\n1;2\n', { delimiter: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('treats an empty document as zero rows', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('enforces maxFieldLength, maxFields, and maxRows', () => {
    expect(() => parseCsv('aaaaa\n', { maxFieldLength: 2 })).toThrow(LimitExceededError);
    expect(() => parseCsv('a,b,c\n', { maxFields: 2 })).toThrow(LimitExceededError);
    expect(() => parseCsv('1\n2\n3\n', { maxRows: 2 })).toThrow(LimitExceededError);
  });
});

describe('CsvParser is chunk-boundary safe', () => {
  const document = 'a,"b,c","say ""hi""\nnext line",d\n1,2,3,4\n';

  it('produces the same rows regardless of how the input is chunked', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: document.length }), { maxLength: 15 }),
        (cutsRaw) => {
          const cuts = [...new Set([0, document.length, ...cutsRaw])].sort((a, b) => a - b);
          const parser = new CsvParser();
          const rows: string[][] = [];
          for (let i = 0; i < cuts.length - 1; i++) {
            rows.push(...parser.push(document.slice(cuts[i], cuts[i + 1])));
          }
          rows.push(...parser.finish());
          expect(rows).toEqual(parseCsv(document));
        },
      ),
    );
  });

  it('is safe one character at a time', () => {
    const parser = new CsvParser();
    const rows: string[][] = [];
    for (const ch of document) rows.push(...parser.push(ch));
    rows.push(...parser.finish());
    expect(rows).toEqual(parseCsv(document));
  });
});

describe('quoteCsvField / encodeCsv', () => {
  it('leaves plain fields unquoted', () => {
    expect(quoteCsvField('plain', ',', '"')).toBe('plain');
  });

  it('quotes fields containing the delimiter, quote, or a newline', () => {
    expect(quoteCsvField('a,b', ',', '"')).toBe('"a,b"');
    expect(quoteCsvField('a"b', ',', '"')).toBe('"a""b"');
    expect(quoteCsvField('a\nb', ',', '"')).toBe('"a\nb"');
  });

  it('round-trips arbitrary rows through encode -> parse', () => {
    // A row of zero fields is not representable in CSV text (a blank line always decodes back as
    // one empty field), so every generated row has at least one field.
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ unit: 'binary' }), { minLength: 1, maxLength: 4 }), {
          maxLength: 5,
        }),
        (rows) => {
          const encoded = encodeCsv(rows);
          const decoded = parseCsv(encoded);
          expect(decoded).toEqual(rows);
        },
      ),
    );
  });
});

describe('decodeCsvToLogEvents / encodeLogEventsAsCsv', () => {
  it('uses the header row for field names', () => {
    const events = decodeCsvToLogEvents('name,age\nalice,30\nbob,25\n');
    expect(events).toHaveLength(2);
    expect(events[0]!.get('name')).toBe('alice');
    expect(events[0]!.get('age')).toBe('30');
    expect(events[1]!.get('name')).toBe('bob');
  });

  it('uses columnN names when header is false and no columns are given', () => {
    const events = decodeCsvToLogEvents('alice,30\n', { header: false });
    expect(events[0]!.get('column0')).toBe('alice');
    expect(events[0]!.get('column1')).toBe('30');
  });

  it('uses explicit columns when header is false', () => {
    const events = decodeCsvToLogEvents('alice,30\n', { header: false, columns: ['name', 'age'] });
    expect(events[0]!.get('name')).toBe('alice');
    expect(events[0]!.get('age')).toBe('30');
  });

  it('leaves missing columns unset for short rows', () => {
    const events = decodeCsvToLogEvents('a,b,c\n1,2\n');
    expect(events[0]!.has('c')).toBe(false);
  });

  it('round-trips events through encodeLogEventsAsCsv -> decodeCsvToLogEvents', () => {
    const events = [
      LogEvent.from({ name: 'alice', age: '30' }),
      LogEvent.from({ name: 'bob, jr.', age: '25' }),
    ];
    const text = encodeLogEventsAsCsv(events, ['name', 'age']);
    const decoded = decodeCsvToLogEvents(text);
    expect(decoded).toHaveLength(2);
    expect(decoded[1]!.get('name')).toBe('bob, jr.');
  });

  it('an empty document decodes to no events', () => {
    expect(decodeCsvToLogEvents('')).toEqual([]);
  });

  it('parses a real-world-shaped export: quoted fields, embedded commas, a trailing blank line, and UTF-8 text', () => {
    const doc =
      'id,name,note,amount\n' +
      '1,"Acme, Inc.","Said ""call me back""",1234.50\n' +
      '2,Café René,"Address:\n123 Main St",99\n' +
      '3,,"",0\n';
    const events = decodeCsvToLogEvents(doc);
    expect(events).toHaveLength(3);
    expect(events[0]!.get('name')).toBe('Acme, Inc.');
    expect(events[0]!.get('note')).toBe('Said "call me back"');
    expect(events[1]!.get('name')).toBe('Café René');
    expect(events[1]!.get('note')).toBe('Address:\n123 Main St');
    expect(events[2]!.get('name')).toBe('');
  });
});
