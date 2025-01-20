import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatByteSize,
  formatDuration,
  parseByteSize,
  parseDuration,
  parseDurationMillis,
  ParseError,
} from '@ferrule/core';

describe('parseDuration', () => {
  it.each([
    ['0', 0n],
    ['1ns', 1n],
    ['1us', 1_000n],
    ['1µs', 1_000n],
    ['250ms', 250_000_000n],
    ['10s', 10_000_000_000n],
    ['1.5s', 1_500_000_000n],
    ['0.1s', 100_000_000n],
    ['2m', 120_000_000_000n],
    ['1h30m', 5_400_000_000_000n],
    ['1d 2h', 93_600_000_000_000n],
    ['1w', 604_800_000_000_000n],
    ['  5s  ', 5_000_000_000n],
  ])('parses %j', (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it.each(['', 's', '5', '5x', '-5s', '5s5', '1m1h', '1s1s', '1.s', '5 s s'])(
    'rejects %j',
    (text) => {
      expect(() => parseDuration(text)).toThrow(ParseError);
    },
  );

  it('converts to milliseconds', () => {
    expect(parseDurationMillis('1.5s')).toBe(1500);
    expect(parseDurationMillis('999us')).toBe(0);
  });

  it('formats durations that parse back to the same value', () => {
    expect(formatDuration(0n)).toBe('0s');
    expect(formatDuration(5_400_000_000_000n)).toBe('1h30m');
    expect(formatDuration(1_500_000_000n)).toBe('1s500ms');
    expect(formatDuration(-2_000_000_000n)).toBe('-2s');
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (nanos) => {
        expect(parseDuration(formatDuration(nanos))).toBe(nanos);
      }),
    );
  });
});

describe('parseByteSize', () => {
  it.each([
    ['0', 0],
    ['4096', 4096],
    ['100b', 100],
    ['1kb', 1000],
    ['1KB', 1000],
    ['1KiB', 1024],
    ['64MiB', 64 * 1024 * 1024],
    ['1.5GB', 1_500_000_000],
    ['2GiB', 2 * 1024 ** 3],
    ['512k', 512 * 1024],
    ['2g', 2 * 1024 ** 3],
    ['1 TiB', 1024 ** 4],
  ])('parses %j', (text, expected) => {
    expect(parseByteSize(text)).toBe(expected);
  });

  it.each(['', 'MB', '-1MB', '1XB', '1.2.3MB', '99999999999TiB'])('rejects %j', (text) => {
    expect(() => parseByteSize(text)).toThrow(ParseError);
  });

  it('formats with binary units', () => {
    expect(formatByteSize(0)).toBe('0B');
    expect(formatByteSize(1023)).toBe('1023B');
    expect(formatByteSize(1024)).toBe('1KiB');
    expect(formatByteSize(1536)).toBe('1.5KiB');
    expect(formatByteSize(64 * 1024 * 1024)).toBe('64MiB');
    expect(() => formatByteSize(-1)).toThrow(RangeError);
  });
});
