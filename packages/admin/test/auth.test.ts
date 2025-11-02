import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkHost, secureEquals } from '../src/auth.js';
import { ForbiddenHostError } from '../src/errors.js';

function fakeRequest(host: string | undefined): IncomingMessage {
  return { headers: host === undefined ? {} : { host } } as IncomingMessage;
}

describe('secureEquals', () => {
  it('is true for identical strings', () => {
    expect(secureEquals('the-token', 'the-token')).toBe(true);
  });

  it('is false for different strings of the same length', () => {
    expect(secureEquals('the-token', 'the-tokeX')).toBe(false);
  });

  it('is false for strings of different lengths, without throwing', () => {
    expect(secureEquals('short', 'a-much-longer-token')).toBe(false);
  });

  it('is false comparing against an empty string', () => {
    expect(secureEquals('', 'the-token')).toBe(false);
    expect(secureEquals('the-token', '')).toBe(false);
  });
});

describe('checkHost (DNS-rebinding guard)', () => {
  const bound = { host: '127.0.0.1', port: 9090 };

  it('accepts the loopback IP at the bound port', () => {
    expect(() => checkHost(fakeRequest('127.0.0.1:9090'), bound, [])).not.toThrow();
  });

  it('accepts "localhost" at the bound port', () => {
    expect(() => checkHost(fakeRequest('localhost:9090'), bound, [])).not.toThrow();
  });

  it('accepts [::1] at the bound port when bound to the IPv6 loopback', () => {
    expect(() =>
      checkHost(fakeRequest('[::1]:9090'), { host: '::1', port: 9090 }, []),
    ).not.toThrow();
  });

  it('is case-insensitive', () => {
    expect(() => checkHost(fakeRequest('LOCALHOST:9090'), bound, [])).not.toThrow();
  });

  it('rejects a Host naming a different port', () => {
    expect(() => checkHost(fakeRequest('127.0.0.1:1234'), bound, [])).toThrow(ForbiddenHostError);
  });

  it('rejects an attacker-controlled DNS name that resolves to loopback', () => {
    expect(() => checkHost(fakeRequest('attacker.example:9090'), bound, [])).toThrow(
      ForbiddenHostError,
    );
  });

  it('rejects a missing Host header', () => {
    expect(() => checkHost(fakeRequest(undefined), bound, [])).toThrow(ForbiddenHostError);
  });

  it('accepts an explicitly configured extra allowed host', () => {
    expect(() =>
      checkHost(fakeRequest('admin.internal:9090'), bound, ['admin.internal:9090']),
    ).not.toThrow();
  });

  it('does not enforce anything when bound to a non-loopback address', () => {
    const wideBound = { host: '0.0.0.0', port: 9090 };
    expect(() => checkHost(fakeRequest('anything.example'), wideBound, [])).not.toThrow();
    expect(() => checkHost(fakeRequest(undefined), wideBound, [])).not.toThrow();
  });
});
