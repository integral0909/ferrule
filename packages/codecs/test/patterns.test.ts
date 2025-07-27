import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LimitExceededError, Timestamp } from '@ferrule/core';
import {
  builtinPatterns,
  CodecSyntaxError,
  PatternNoMatchError,
  PatternRegistry,
} from '@ferrule/codecs';

describe('PatternRegistry: basic compilation and matching', () => {
  it('matches a plain regex fragment with no references', () => {
    const registry = new PatternRegistry();
    const compiled = registry.compile('[a-z]+');
    expect(compiled.test('abc')).toBe(true);
    expect(compiled.match('abc')).toEqual(new Map());
    expect(compiled.test('ABC')).toBe(false);
  });

  it('supports a named reference with no capture', () => {
    const registry = new PatternRegistry().define('WORD', String.raw`\w+`);
    const compiled = registry.compile('%{WORD} %{WORD}');
    expect(compiled.test('hello world')).toBe(true);
  });

  it('supports a named capture', () => {
    const registry = new PatternRegistry().define('WORD', String.raw`\w+`);
    const compiled = registry.compile('%{WORD:first} %{WORD:second}');
    const fields = compiled.match('hello world');
    expect(fields?.get('first')).toBe('hello');
    expect(fields?.get('second')).toBe('world');
  });

  it('converts typed captures to int, float, and timestamp', () => {
    const registry = new PatternRegistry()
      .define('INT', String.raw`[+-]?\d+`)
      .define('NUMBER', String.raw`[+-]?\d+(?:\.\d+)?`);
    const tsRegistry = new PatternRegistry().define(
      'ISO',
      String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`,
    );
    const withInt = registry.compile('%{INT:n:int}');
    expect(withInt.match('42')?.get('n')).toBe(42n);
    expect(withInt.match('-7')?.get('n')).toBe(-7n);

    const withFloat = registry.compile('%{NUMBER:f:float}');
    expect(withFloat.match('3.5')?.get('f')).toBe(3.5);

    const withTs = tsRegistry.compile('%{ISO:t:timestamp}');
    const result = withTs.match('2024-01-02T03:04:05Z');
    expect(result?.get('t')).toEqual(Timestamp.parse('2024-01-02T03:04:05Z'));
  });

  it('throws a typed error when a typed capture does not convert', () => {
    const registry = new PatternRegistry().define('ANY', '.+');
    const compiled = registry.compile('%{ANY:n:int}');
    expect(() => compiled.match('not-a-number')).toThrow(CodecSyntaxError);
  });

  it('supports patterns referencing other patterns, transitively', () => {
    const registry = new PatternRegistry()
      .define('DIGIT', '[0-9]')
      .define('TWODIGIT', '%{DIGIT}%{DIGIT}')
      .define('YEAR', '%{TWODIGIT}%{TWODIGIT}');
    const compiled = registry.compile('%{YEAR:year}');
    expect(compiled.match('2024')?.get('year')).toBe('2024');
  });

  it('rejects a reference to an unknown pattern', () => {
    const registry = new PatternRegistry();
    expect(() => registry.compile('%{NOPE}')).toThrow(CodecSyntaxError);
  });

  it('rejects a cyclic pattern reference', () => {
    const registry = new PatternRegistry().define('A', '%{B}').define('B', '%{A}');
    expect(() => registry.compile('%{A}')).toThrow();
  });

  it('rejects a duplicate pattern name via the fluent define() validator', () => {
    expect(() => new PatternRegistry().define('bad name', 'x')).toThrow(CodecSyntaxError);
  });

  it('anchors by default (whole-string match)', () => {
    const registry = new PatternRegistry().define('WORD', String.raw`\w+`);
    const compiled = registry.compile('%{WORD}');
    expect(compiled.test('hello world')).toBe(false);
  });

  it('can be configured to search a substring instead of anchoring', () => {
    const registry = new PatternRegistry().define('WORD', String.raw`\w+`);
    const compiled = registry.compile('%{WORD}', { anchored: false });
    expect(compiled.test('  hello  ')).toBe(true);
  });

  it('supports case-insensitive matching', () => {
    const compiled = new PatternRegistry().compile('abc', { caseInsensitive: true });
    expect(compiled.test('ABC')).toBe(true);
  });

  it('decode() builds a LogEvent from the captures and throws PatternNoMatchError on no match', () => {
    const registry = new PatternRegistry().define('WORD', String.raw`\w+`);
    const compiled = registry.compile('%{WORD:w}');
    const event = compiled.decode('hello');
    expect(event.get('w')).toBe('hello');
    expect(() => compiled.decode('not a single word')).toThrow(PatternNoMatchError);
  });

  it('a base registry can be extended without mutating the original', () => {
    const base = new PatternRegistry().define('A', 'a');
    const extended = new PatternRegistry(base).define('B', 'b');
    expect(base.has('B')).toBe(false);
    expect(extended.has('A')).toBe(true);
    expect(extended.has('B')).toBe(true);
  });

  it('enforces maxDepth against long reference chains', () => {
    const registry = new PatternRegistry();
    let prev = 'x';
    registry.define('P0', 'x');
    for (let i = 1; i <= 50; i++) {
      registry.define(`P${i}`, `%{P${i - 1}}`);
      prev = `P${i}`;
    }
    expect(() => registry.compile(`%{${prev}}`, { maxDepth: 10 })).toThrow(LimitExceededError);
  });

  it('enforces maxInputLength at match time', () => {
    const compiled = new PatternRegistry().compile('.*', { maxInputLength: 5, anchored: false });
    expect(() => compiled.match('too long input')).toThrow(LimitExceededError);
    expect(() => compiled.test('too long input')).toThrow(LimitExceededError);
  });

  it('flags a pattern chaining two unbounded wildcards with only grouping between them', () => {
    const registry = new PatternRegistry().define('G', '.*').define('H', '.*');
    expect(() => registry.compile('%{G}%{H}')).toThrow(CodecSyntaxError);
  });

  it('does not flag two unbounded wildcards separated by a literal', () => {
    const registry = new PatternRegistry();
    expect(() => registry.compile('.*,.*')).not.toThrow();
  });

  it('never throws anything but a FerruleError when compiling arbitrary reference text', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          new PatternRegistry().compile(s);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
    );
  });
});

describe('builtinPatterns library', () => {
  it('INT, NUMBER, WORD, IPV4, UUID match their canonical examples', () => {
    expect(builtinPatterns.compile('%{INT}').test('-42')).toBe(true);
    expect(builtinPatterns.compile('%{NUMBER}').test('-3.14e10')).toBe(true);
    expect(builtinPatterns.compile('%{WORD}').test('hello_world')).toBe(true);
    expect(builtinPatterns.compile('%{IPV4}').test('192.168.1.1')).toBe(true);
    expect(builtinPatterns.compile('%{IPV4}').test('999.1.1.1')).toBe(false);
    expect(builtinPatterns.compile('%{UUID}').test('123e4567-e89b-12d3-a456-426614174000')).toBe(
      true,
    );
  });

  it('IP matches both IPv4 and IPv6', () => {
    const compiled = builtinPatterns.compile('%{IP}');
    expect(compiled.test('10.0.0.1')).toBe(true);
    expect(compiled.test('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
  });

  it('HOSTNAME matches a dotted domain name', () => {
    expect(builtinPatterns.compile('%{HOSTNAME}').test('www.example.com')).toBe(true);
  });

  it('TIMESTAMP_ISO8601 matches common ISO forms', () => {
    const compiled = builtinPatterns.compile('%{TIMESTAMP_ISO8601}');
    expect(compiled.test('2024-01-02T03:04:05Z')).toBe(true);
    expect(compiled.test('2024-01-02T03:04:05.123456+02:00')).toBe(true);
    expect(compiled.test('2024-01-02 03:04:05')).toBe(true);
  });

  it('COMMONAPACHELOG parses a Common Log Format line', () => {
    const line =
      '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326';
    const compiled = builtinPatterns.compile('%{COMMONAPACHELOG}');
    const fields = compiled.match(line);
    expect(fields?.get('clientip')).toBe('127.0.0.1');
    expect(fields?.get('ident')).toBe('-');
    expect(fields?.get('auth')).toBe('frank');
    expect(fields?.get('verb')).toBe('GET');
    expect(fields?.get('request')).toBe('/apache_pb.gif');
    expect(fields?.get('httpversion')).toBe('1.0');
    expect(fields?.get('response')).toBe('200');
    expect(fields?.get('bytes')).toBe('2326');
  });

  it('COMMONAPACHELOG accepts "-" for bytes', () => {
    const line = '127.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET / HTTP/1.1" 304 -';
    const fields = builtinPatterns.compile('%{COMMONAPACHELOG}').match(line);
    expect(fields?.get('response')).toBe('304');
    expect(fields?.get('bytes')).toBeUndefined();
  });

  it('COMBINEDAPACHELOG additionally captures referrer and user agent', () => {
    const line =
      '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 ' +
      '"http://www.example.com/start.html" "Mozilla/4.08 [en] (Win98; I ;Nav)"';
    const fields = builtinPatterns.compile('%{COMBINEDAPACHELOG}').match(line);
    expect(fields?.get('clientip')).toBe('127.0.0.1');
    expect(fields?.get('referrer')).toBe('http://www.example.com/start.html');
    expect(fields?.get('agent')).toBe('Mozilla/4.08 [en] (Win98; I ;Nav)');
  });

  it('NGINXACCESSLOG parses a typical nginx access line', () => {
    const line =
      '203.0.113.5 - - [10/Oct/2020:13:55:36 +0000] "GET /health HTTP/1.1" 200 15 "-" "curl/7.68.0"';
    const fields = builtinPatterns.compile('%{NGINXACCESSLOG}').match(line);
    expect(fields?.get('clientip')).toBe('203.0.113.5');
    expect(fields?.get('verb')).toBe('GET');
    expect(fields?.get('request')).toBe('/health');
    expect(fields?.get('response')).toBe('200');
    expect(fields?.get('agent')).toBe('curl/7.68.0');
  });

  it('SYSLOGLINE parses a classic BSD-style line', () => {
    const fields = builtinPatterns
      .compile('%{SYSLOGLINE}')
      .match('Oct 11 22:14:15 mymachine su[1234]: failure');
    expect(fields?.get('hostname')).toBe('mymachine');
    expect(fields?.get('program')).toBe('su');
    expect(fields?.get('pid')).toBe('1234');
    expect(fields?.get('message')).toBe('failure');
  });

  it('every built-in whole-line pattern compiles without a backtracking-risk error', () => {
    for (const name of ['COMMONAPACHELOG', 'COMBINEDAPACHELOG', 'NGINXACCESSLOG', 'SYSLOGLINE']) {
      expect(() => builtinPatterns.compile(`%{${name}}`)).not.toThrow();
    }
  });

  it('EMAIL matches a typical address', () => {
    const compiled = builtinPatterns.compile('%{EMAIL}');
    expect(compiled.test('jane.doe+alerts@example.co.uk')).toBe(true);
    expect(compiled.test('not-an-email')).toBe(false);
  });

  it('PATH and WINDOWS_PATH match Unix and Windows-style paths', () => {
    expect(builtinPatterns.compile('%{PATH}').test('/var/log/app.log')).toBe(true);
    expect(
      builtinPatterns.compile('%{WINDOWS_PATH}').test(String.raw`C:\Users\alice\app.log`),
    ).toBe(true);
  });

  it('LOGLEVEL matches common level names', () => {
    const compiled = builtinPatterns.compile('%{LOGLEVEL}');
    for (const level of [
      'TRACE',
      'DEBUG',
      'INFO',
      'WARN',
      'WARNING',
      'ERROR',
      'CRITICAL',
      'FATAL',
    ]) {
      expect(compiled.test(level)).toBe(true);
    }
    expect(compiled.test('NOTALEVEL')).toBe(false);
  });

  it('DURATION matches a number with a time unit', () => {
    const compiled = builtinPatterns.compile('%{DURATION}');
    expect(compiled.test('150ms')).toBe(true);
    expect(compiled.test('2.5s')).toBe(true);
    expect(compiled.test('1h')).toBe(true);
  });

  it('IPV6 matches compressed, IPv4-mapped, and link-local-with-zone forms', () => {
    const compiled = builtinPatterns.compile('%{IPV6}');
    expect(compiled.test('::1')).toBe(true);
    expect(compiled.test('2001:db8::1')).toBe(true);
    expect(compiled.test('::ffff:192.168.1.1')).toBe(true);
    expect(compiled.test('fe80::1%eth0')).toBe(true);
    expect(compiled.test('not-an-ipv6-address')).toBe(false);
  });

  it('a custom pattern built from library fragments composes cleanly', () => {
    const app = new PatternRegistry(builtinPatterns).define(
      'APP_LINE',
      '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} %{WORD:component}: %{GREEDYDATA:message}',
    );
    const fields = app
      .compile('%{APP_LINE}')
      .match('2024-06-15T12:00:00Z ERROR db_pool: connection refused after 30s');
    expect(fields?.get('level')).toBe('ERROR');
    expect(fields?.get('component')).toBe('db_pool');
    expect(fields?.get('message')).toBe('connection refused after 30s');
  });

  it('PATH and WINDOWS_PATH do not exhibit catastrophic backtracking on a long non-matching input', () => {
    const path = builtinPatterns.compile('%{PATH}$x', { anchored: false });
    const windows = builtinPatterns.compile('%{WINDOWS_PATH}$x', { anchored: false });
    const longInput = `/${'a'.repeat(5000)}`;
    const start = Date.now();
    path.test(longInput);
    windows.test(String.raw`C:\${'a'.repeat(5000)}`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
