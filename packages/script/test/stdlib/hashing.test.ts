import { LogEvent } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import type { Failure } from '@ferrule/script';
import {
  compile,
  createDefaultImplementations,
  createDefaultRegistry,
  createRunCtx,
  EMPTY_SPAN,
  isFailure,
  parseAndCheck,
  RateLimiter,
  type CallArgs,
  type RunCtx,
  type RuntimeValue,
} from '@ferrule/script';

const registry = createDefaultRegistry();
const impls = createDefaultImplementations();

function ctx(): RunCtx {
  return createRunCtx(LogEvent.from({}), undefined, new RateLimiter(1000), EMPTY_SPAN);
}

function call(
  name: string,
  positional: readonly RuntimeValue[],
  named?: ReadonlyMap<string, RuntimeValue>,
): RuntimeValue | Failure {
  const args: CallArgs = {
    positional,
    named: named ?? new Map(),
    closures: [],
    positionalSupplied: positional.map(() => true),
  };
  return impls.get(name)!.call(args, ctx(), EMPTY_SPAN);
}

describe('stdlib signatures', () => {
  for (const name of ['sha1', 'sha256', 'md5', 'hmac', 'uuid_v4', 'uuid_v7']) {
    it(`registers ${name}`, () => {
      expect(registry.has(name)).toBe(true);
      expect(registry.get(name)!.docs.length).toBeGreaterThan(0);
      expect(impls.has(name)).toBe(true);
    });
  }

  it('marks uuid_v4/uuid_v7 as impure', () => {
    expect(registry.get('uuid_v4')?.pure).toBe(false);
    expect(registry.get('uuid_v7')?.pure).toBe(false);
  });
});

describe('sha1 / sha256 / md5 (known-answer tests)', () => {
  it('sha256("") matches the well-known empty digest', () => {
    expect(call('sha256', [''])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.slice(0, 64),
    );
  });

  it('sha1("") matches the well-known empty digest', () => {
    expect(call('sha1', [''])).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('md5("") matches the well-known empty digest', () => {
    expect(call('md5', [''])).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('sha256("abc") matches its well-known digest', () => {
    expect(call('sha256', ['abc'])).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes bytes the same as the equivalent UTF-8 string', () => {
    const text = 'hello, ferrule';
    const bytes = new TextEncoder().encode(text);
    expect(call('sha256', [bytes])).toBe(call('sha256', [text]));
    expect(call('sha1', [bytes])).toBe(call('sha1', [text]));
    expect(call('md5', [bytes])).toBe(call('md5', [text]));
  });

  it('hashes unicode content (emoji, accented characters)', () => {
    const text = 'café 🎉';
    const digest = call('sha256', [text]) as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // stable and equal to hashing the same UTF-8 bytes directly
    expect(digest).toBe(call('sha256', [new TextEncoder().encode(text)]));
  });

  it('fails for a mismatched argument type', () => {
    expect(isFailure(call('sha256', [42n]))).toBe(true);
    expect(isFailure(call('sha1', [true]))).toBe(true);
    expect(isFailure(call('md5', [null]))).toBe(true);
  });
});

describe('hmac', () => {
  it('matches a well-known HMAC-SHA256 test vector', () => {
    const result = call(
      'hmac',
      ['The quick brown fox jumps over the lazy dog', 'key'],
      new Map([['algorithm', 'sha256']]),
    );
    expect(result).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'.slice(0, 64),
    );
  });

  it('defaults to sha256', () => {
    const withDefault = call('hmac', ['message', 'key']);
    const explicit = call('hmac', ['message', 'key'], new Map([['algorithm', 'sha256']]));
    expect(withDefault).toBe(explicit);
  });

  it('accepts bytes for value and key', () => {
    const enc = new TextEncoder();
    const result = call('hmac', [enc.encode('message'), enc.encode('key')]);
    expect(result).toBe(call('hmac', ['message', 'key']));
  });

  it('supports sha1/sha512/md5 algorithms', () => {
    for (const algorithm of ['sha1', 'sha512', 'md5']) {
      const result = call('hmac', ['msg', 'key'], new Map([['algorithm', algorithm]]));
      expect(isFailure(result)).toBe(false);
      expect(typeof result).toBe('string');
    }
  });

  it('fails for an unknown algorithm', () => {
    const result = call('hmac', ['msg', 'key'], new Map([['algorithm', 'not-an-algorithm']]));
    expect(isFailure(result)).toBe(true);
  });

  it('fails for a mismatched argument type', () => {
    expect(isFailure(call('hmac', [42n, 'key']))).toBe(true);
    expect(isFailure(call('hmac', ['msg', 42n]))).toBe(true);
  });
});

describe('uuid_v4', () => {
  it('generates a well-formed version-4 UUID', () => {
    const id = call('uuid_v4', []) as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates distinct values across calls', () => {
    const a = call('uuid_v4', []) as string;
    const b = call('uuid_v4', []) as string;
    expect(a).not.toBe(b);
  });
});

describe('uuid_v7', () => {
  it('generates a well-formed UUID with version 7 and RFC 4122 variant bits', () => {
    const id = call('uuid_v7', []) as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates distinct values across calls', () => {
    const a = call('uuid_v7', []) as string;
    const b = call('uuid_v7', []) as string;
    expect(a).not.toBe(b);
  });

  it('sorts lexicographically in time order across distinct milliseconds', () => {
    const first = call('uuid_v7', []) as string;
    const start = Date.now();
    while (Date.now() === start) {
      // busy-wait until the millisecond clock advances, so the two IDs embed different
      // timestamps and are guaranteed to sort in time order.
    }
    const second = call('uuid_v7', []) as string;
    expect(first < second).toBe(true);
  });
});

describe('end to end', () => {
  function compileSource(source: string) {
    const result = parseAndCheck(source);
    const diagnostics = [...result.parseDiagnostics, ...result.diagnostics];
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      throw new Error(
        `unexpected diagnostics: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
      );
    }
    return compile(result);
  }

  it('runs sha256 through a compiled program', () => {
    const program = compileSource('.digest = sha256(.body)!');
    const outcome = program.run(LogEvent.from({ body: 'abc' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('digest')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.slice(0, 64),
      );
    }
  });

  it('runs uuid_v4 through a compiled program', () => {
    const program = compileSource('.id = uuid_v4()');
    const outcome = program.run(LogEvent.from({}));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
