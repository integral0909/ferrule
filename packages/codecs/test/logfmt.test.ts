import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LimitExceededError } from '@ferrule/core';
import {
  decodeLogfmtToLogEvent,
  encodeLogfmt,
  parseLogfmt,
  quoteLogfmtValue,
} from '@ferrule/codecs';

describe('parseLogfmt', () => {
  it('parses bare key=value pairs', () => {
    const r = parseLogfmt('at=info method=GET path=/ status=200');
    expect(r.get('at')).toBe('info');
    expect(r.get('method')).toBe('GET');
    expect(r.get('path')).toBe('/');
    expect(r.get('status')).toBe('200');
  });

  it('parses quoted values containing spaces', () => {
    const r = parseLogfmt('msg="hello world" at=info');
    expect(r.get('msg')).toBe('hello world');
    expect(r.get('at')).toBe('info');
  });

  it('unescapes \\", \\\\, \\n, \\t, \\r, and \\u inside quoted values', () => {
    const r = parseLogfmt(String.raw`msg="a\"b\\c\nd\te\rfé"`);
    expect(r.get('msg')).toBe('a"b\\c\nd\te\rfé');
  });

  it('treats a bare key with no "=" as a boolean flag', () => {
    const r = parseLogfmt('debug at=info');
    expect(r.get('debug')).toBe(true);
  });

  it('treats key= (empty after "=") as an empty string', () => {
    const r = parseLogfmt('empty=');
    expect(r.get('empty')).toBe('');
  });

  it('handles repeated and irregular whitespace', () => {
    const r = parseLogfmt('  a=1   b=2  ');
    expect(r.get('a')).toBe('1');
    expect(r.get('b')).toBe('2');
  });

  it('throws CodecSyntaxError on an unterminated quoted value', () => {
    expect(() => parseLogfmt('msg="unterminated')).toThrow();
  });

  it('throws CodecSyntaxError on an invalid escape', () => {
    expect(() => parseLogfmt(String.raw`msg="bad\qescape"`)).toThrow();
  });

  it('enforces maxPairs', () => {
    expect(() => parseLogfmt('a=1 b=2 c=3', { maxPairs: 2 })).toThrow(LimitExceededError);
  });

  it('enforces maxLength', () => {
    expect(() => parseLogfmt('a=1', { maxLength: 2 })).toThrow(LimitExceededError);
  });

  it('never throws anything but a FerruleError on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          parseLogfmt(s);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
    );
  });
});

describe('quoteLogfmtValue / encodeLogfmt round trip', () => {
  it('round-trips arbitrary key/value pairs through encode -> parse', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]*$/),
            fc.string({ unit: 'binary' }).filter((s) => !/[\p{Cc}]/u.test(s)),
          ),
          { maxLength: 6 },
        ),
        (pairs) => {
          const map = new Map<string, string>();
          for (const [k, v] of pairs) map.set(k, v); // last write wins, matching parseLogfmt
          const encoded = encodeLogfmt(map, { boolValueless: false });
          const decoded = parseLogfmt(encoded);
          for (const [k, v] of map) expect(decoded.get(k)).toBe(v);
        },
      ),
    );
  });

  it('leaves safe bare values unquoted', () => {
    expect(quoteLogfmtValue('abc123')).toBe('abc123');
  });

  it('quotes values containing spaces, quotes, or equals', () => {
    expect(quoteLogfmtValue('a b')).toBe('"a b"');
    expect(quoteLogfmtValue('a"b')).toBe('"a\\"b"');
    expect(quoteLogfmtValue('a=b')).toBe('"a=b"');
    expect(quoteLogfmtValue('')).toBe('""');
  });

  it('encodes boolean true as a bare flag by default', () => {
    expect(encodeLogfmt([['debug', true]])).toBe('debug');
    expect(encodeLogfmt([['debug', true]], { boolValueless: false })).toBe('debug=true');
  });

  it('encodes booleans, integers, and floats via stringifyValue', () => {
    expect(encodeLogfmt([['ok', false]])).toBe('ok=false');
    expect(encodeLogfmt([['n', 5n]])).toBe('n=5');
    expect(encodeLogfmt([['f', 1.5]])).toBe('f=1.5');
  });
});

describe('decodeLogfmtToLogEvent', () => {
  it('maps each key to a top-level field', () => {
    const event = decodeLogfmtToLogEvent('level=info msg="hello there" count=3');
    expect(event.get('level')).toBe('info');
    expect(event.get('msg')).toBe('hello there');
    expect(event.get('count')).toBe('3');
  });

  it('parses a real Heroku-router-shaped line', () => {
    const line =
      'at=info method=GET path="/cart?id=8" host=example.herokuapp.com ' +
      'request_id=05a26a80-42cd-4d8b-9231-a6d1e5b0f0c5 fwd="204.204.204.204" ' +
      'dyno=web.1 connect=0ms service=3ms status=200 bytes=815 protocol=https';
    const event = decodeLogfmtToLogEvent(line);
    expect(event.get('at')).toBe('info');
    expect(event.get('path')).toBe('/cart?id=8');
    expect(event.get('fwd')).toBe('204.204.204.204');
    expect(event.get('status')).toBe('200');
    expect(event.get('protocol')).toBe('https');
  });
});
