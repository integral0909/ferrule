import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LimitExceededError } from '@ferrule/core';
import {
  decodeKeyValueToLogEvent,
  encodeKeyValue,
  parseKeyValue,
  quoteKeyValue,
} from '@ferrule/codecs';

describe('parseKeyValue', () => {
  it('parses space-separated key=value pairs (logfmt-like default)', () => {
    const r = parseKeyValue('a=1 b=2 c=3');
    expect(r.get('a')).toBe('1');
    expect(r.get('b')).toBe('2');
    expect(r.get('c')).toBe('3');
  });

  it('parses a semicolon-separated connection-string style', () => {
    const r = parseKeyValue('host=localhost;port=5432;user=admin', { pairSeparator: ';' });
    expect(r.get('host')).toBe('localhost');
    expect(r.get('port')).toBe('5432');
    expect(r.get('user')).toBe('admin');
  });

  it('parses a comma-separated, colon-valued style', () => {
    const r = parseKeyValue('a:1,b:2', { pairSeparator: ',', kvSeparator: ':' });
    expect(r.get('a')).toBe('1');
    expect(r.get('b')).toBe('2');
  });

  it('parses quoted values that contain the pair separator', () => {
    const r = parseKeyValue('msg="a; b" x=1', { pairSeparator: ';' });
    expect(r.get('msg x')).toBeUndefined();
    // With ';' as the pair separator, "msg=\"a; b\" x=1" is one pair spanning the quote.
    const r2 = parseKeyValue('msg="a; b";x=1', { pairSeparator: ';' });
    expect(r2.get('msg')).toBe('a; b');
    expect(r2.get('x')).toBe('1');
  });

  it('unescapes \\" and \\\\ inside quoted values', () => {
    const r = parseKeyValue(String.raw`msg="a\"b\\c"`);
    expect(r.get('msg')).toBe('a"b\\c');
  });

  it('a bare key with no separator decodes to an empty string', () => {
    const r = parseKeyValue('flag a=1');
    expect(r.get('flag')).toBe('');
  });

  it('can disable quote-awareness entirely', () => {
    const r = parseKeyValue('a="quoted"', { quote: '' });
    expect(r.get('a')).toBe('"quoted"');
  });

  it('trims surrounding whitespace from bare keys and values', () => {
    const r = parseKeyValue('a = 1 ; b = 2', { pairSeparator: ';' });
    expect(r.get('a')).toBe('1');
    expect(r.get('b')).toBe('2');
  });

  it('throws on an unterminated quoted value', () => {
    expect(() => parseKeyValue('a="unterminated')).toThrow();
  });

  it('enforces maxPairs and maxLength', () => {
    expect(() => parseKeyValue('a=1 b=2', { maxPairs: 1 })).toThrow(LimitExceededError);
    expect(() => parseKeyValue('a=1', { maxLength: 1 })).toThrow(LimitExceededError);
  });

  it('never throws anything but a FerruleError on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          parseKeyValue(s);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
    );
  });
});

describe('quoteKeyValue / encodeKeyValue', () => {
  it('leaves values with no special characters unquoted', () => {
    expect(quoteKeyValue('abc', ' ', '=', '"')).toBe('abc');
  });

  it('quotes values containing the pair separator, kv separator, or quote char', () => {
    expect(quoteKeyValue('a b', ' ', '=', '"')).toBe('"a b"');
    expect(quoteKeyValue('a=b', ' ', '=', '"')).toBe('"a=b"');
    expect(quoteKeyValue('a"b', ' ', '=', '"')).toBe('"a\\"b"');
    expect(quoteKeyValue('', ' ', '=', '"')).toBe('""');
  });

  it('round-trips through encodeKeyValue -> parseKeyValue with custom separators', () => {
    const entries: [string, string][] = [
      ['host', 'db.internal'],
      ['note', 'contains; a semicolon'],
      ['empty', ''],
    ];
    const encoded = encodeKeyValue(entries, { pairSeparator: ';', kvSeparator: '=' });
    const decoded = parseKeyValue(encoded, { pairSeparator: ';', kvSeparator: '=' });
    for (const [k, v] of entries) expect(decoded.get(k)).toBe(v);
  });
});

describe('decodeKeyValueToLogEvent', () => {
  it('maps each key to a top-level string field', () => {
    const event = decodeKeyValueToLogEvent('user=alice role=admin');
    expect(event.get('user')).toBe('alice');
    expect(event.get('role')).toBe('admin');
  });
});
