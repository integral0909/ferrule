import { LogEvent, Timestamp } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import {
  createDefaultImplementations,
  DEFAULT_LIMITS,
  EMPTY_SPAN,
  isFailure,
  RateLimiter,
  RegexValue,
  type CallArgs,
  type Failure,
  type RunCtx,
  type RuntimeValue,
} from '@ferrule/script';

const impls = createDefaultImplementations();

function makeCtx(): RunCtx {
  return {
    event: new LogEvent(),
    limits: DEFAULT_LIMITS,
    clock: () => Timestamp.now(),
    onLog: () => {},
    logLimiter: new RateLimiter(1000),
    emitted: [],
    currentSpan: EMPTY_SPAN,
  };
}

function call(
  name: string,
  positional: readonly RuntimeValue[],
  named: Record<string, RuntimeValue> = {},
): RuntimeValue | Failure {
  const implementation = impls.get(name);
  if (implementation === undefined) throw new Error(`no implementation registered for ${name}`);
  const args: CallArgs = {
    positional,
    named: new Map(Object.entries(named)),
    closures: [],
    positionalSupplied: positional.map(() => true),
  };
  return implementation.call(args, makeCtx(), EMPTY_SPAN);
}

function regex(source: string, flags = ''): RegexValue {
  return new RegexValue(new RegExp(source, flags), source, flags);
}

describe('redact_ip', () => {
  it('zeros IPv4 host bits beyond a /24', () => {
    expect(call('redact_ip', ['203.0.113.5', 24n])).toBe('203.0.113.0');
  });

  it('zeros IPv4 host bits beyond a /16', () => {
    expect(call('redact_ip', ['203.0.113.5', 16n])).toBe('203.0.0.0');
  });

  it('keep_prefix 32 leaves an IPv4 address unchanged', () => {
    expect(call('redact_ip', ['203.0.113.5', 32n])).toBe('203.0.113.5');
  });

  it('keep_prefix 0 zeros an IPv4 address entirely', () => {
    expect(call('redact_ip', ['203.0.113.5', 0n])).toBe('0.0.0.0');
  });

  it('a /24 does not need to fall on a whole octet boundary', () => {
    // 203.0.113.5 with 20 bits kept: 203.0.113 is 203.0.0110 0001 -> keep 4 bits of the 3rd octet
    expect(call('redact_ip', ['203.0.113.5', 20n])).toBe('203.0.112.0');
  });

  it('fails on invalid IPv4 (out of range octet)', () => {
    expect(isFailure(call('redact_ip', ['203.0.113.999', 24n]))).toBe(true);
  });

  it('fails on invalid IPv4 (leading zero octet)', () => {
    expect(isFailure(call('redact_ip', ['203.0.113.05', 24n]))).toBe(true);
  });

  it('fails when keep_prefix is out of range for IPv4', () => {
    expect(isFailure(call('redact_ip', ['203.0.113.5', 40n]))).toBe(true);
    expect(isFailure(call('redact_ip', ['203.0.113.5', -1n]))).toBe(true);
  });

  it('redacts a full IPv6 address', () => {
    expect(call('redact_ip', ['2001:db8:1234:5678:9abc:def0:1234:5678', 32n])).toBe('2001:db8::');
  });

  it('redacts a compressed IPv6 address, preserving compression on output', () => {
    expect(call('redact_ip', ['2001:db8::1', 48n])).toBe('2001:db8::');
  });

  it('keep_prefix 128 leaves an IPv6 address unchanged', () => {
    expect(call('redact_ip', ['2001:db8::1', 128n])).toBe('2001:db8::1');
  });

  it('fails when keep_prefix is out of range for IPv6', () => {
    expect(isFailure(call('redact_ip', ['2001:db8::1', 200n]))).toBe(true);
  });

  it('fails on garbage input', () => {
    expect(isFailure(call('redact_ip', ['not-an-ip', 24n]))).toBe(true);
    expect(isFailure(call('redact_ip', ['', 24n]))).toBe(true);
  });

  it('fails on a non-string value or non-int keep_prefix', () => {
    expect(isFailure(call('redact_ip', [1n, 24n]))).toBe(true);
    expect(isFailure(call('redact_ip', ['203.0.113.5', '24']))).toBe(true);
  });
});

describe('redact', () => {
  it('replaces every match of a regex pattern with the default replacement', () => {
    const result = call('redact', ['card 4111111111111111 ok', [regex('\\b\\d{16}\\b')]]);
    expect(result).toBe('card [REDACTED] ok');
  });

  it('replaces every occurrence of a literal string pattern', () => {
    const result = call('redact', ['user alice said hi to alice', ['alice']]);
    expect(result).toBe('user [REDACTED] said hi to [REDACTED]');
  });

  it('applies multiple patterns in order, each seeing the previous output', () => {
    const result = call('redact', ['alice: 4111111111111111', ['alice', regex('\\d{16}')]], {
      replacement: '#',
    });
    expect(result).toBe('#: #');
  });

  it('uses a custom replacement', () => {
    expect(call('redact', ['secret: abc123', [regex('abc123')]], { replacement: '***' })).toBe(
      'secret: ***',
    );
  });

  it('an empty patterns array leaves the value unchanged', () => {
    expect(call('redact', ['hello', []])).toBe('hello');
  });

  it('a pattern with no match leaves the value unchanged', () => {
    expect(call('redact', ['hello', [regex('\\d+')]])).toBe('hello');
  });

  it('fails on a non-string value', () => {
    expect(isFailure(call('redact', [1n, [regex('x')]]))).toBe(true);
  });

  it('fails on a non-array patterns argument', () => {
    expect(isFailure(call('redact', ['hello', 'x']))).toBe(true);
  });
});

describe('mask', () => {
  it('masks everything but the last 4 characters by default', () => {
    expect(call('mask', ['4111111111111111'])).toBe('************1111');
  });

  it('respects keep_start and keep_end', () => {
    expect(call('mask', ['4111111111111111'], { keep_start: 4n, keep_end: 4n })).toBe(
      '4111********1111',
    );
  });

  it('respects a custom mask character', () => {
    expect(call('mask', ['secret'], { keep_start: 0n, keep_end: 2n, char: '#' })).toBe('####et');
  });

  it('returns the value unchanged when keep_start + keep_end covers the whole string', () => {
    expect(call('mask', ['ab'], { keep_start: 1n, keep_end: 4n })).toBe('ab');
  });

  it('returns an empty string unchanged', () => {
    expect(call('mask', [''])).toBe('');
  });

  it('preserves the original length when char is one character', () => {
    const result = call('mask', ['0123456789']) as string;
    expect(result).toHaveLength(10);
  });

  it('fails on negative keep_start or keep_end', () => {
    expect(isFailure(call('mask', ['x'], { keep_start: -1n }))).toBe(true);
    expect(isFailure(call('mask', ['x'], { keep_start: 0n, keep_end: -1n }))).toBe(true);
  });

  it('fails on a non-string value', () => {
    expect(isFailure(call('mask', [1n]))).toBe(true);
  });
});
