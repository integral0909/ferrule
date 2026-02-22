import { LogEvent, type Value } from '@ferrule/core';
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
  RegexValue,
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
  runCtx: RunCtx = ctx(),
): RuntimeValue | Failure {
  const args: CallArgs = {
    positional,
    named: named ?? new Map(),
    closures: [],
    positionalSupplied: positional.map(() => true),
  };
  return impls.get(name)!.call(args, runCtx, EMPTY_SPAN);
}

describe('stdlib signatures', () => {
  for (const name of [
    'encode_json',
    'encode_base64',
    'decode_base64',
    'encode_hex',
    'decode_hex',
    'encode_percent',
    'decode_percent',
  ]) {
    it(`registers ${name}`, () => {
      expect(registry.has(name)).toBe(true);
      expect(registry.get(name)!.docs.length).toBeGreaterThan(0);
      expect(impls.has(name)).toBe(true);
    });
  }
});

describe('encode_json', () => {
  it('encodes a compact object', () => {
    const result = call('encode_json', [new Map<string, Value>([['a', 1n]])]);
    expect(result).toBe('{"a":1}');
  });

  it('pretty-prints with 2-space indent when pretty: true', () => {
    const result = call(
      'encode_json',
      [new Map<string, Value>([['a', 1n]])],
      new Map([['pretty', true]]),
    );
    expect(result).toBe('{\n  "a": 1\n}');
  });

  it('encodes strings, arrays, and unicode content', () => {
    expect(call('encode_json', ['héllo 🚀'])).toBe('"héllo 🚀"');
    expect(call('encode_json', [[1n, 2n, 3n]])).toBe('[1,2,3]');
  });

  it('fails for a non-finite float', () => {
    const result = call('encode_json', [Number.NaN]);
    expect(isFailure(result)).toBe(true);
  });

  it('fails for a regex value', () => {
    const result = call('encode_json', [new RegexValue(/x/, 'x', '')]);
    expect(isFailure(result)).toBe(true);
  });

  it('fails for a cyclic value (depth limit)', () => {
    const cyclic = new Map<string, Value>();
    cyclic.set('self', cyclic);
    const result = call('encode_json', [cyclic]);
    expect(isFailure(result)).toBe(true);
  });
});

describe('encode_base64 / decode_base64', () => {
  it('encodes a string as UTF-8 base64', () => {
    expect(call('encode_base64', ['hello'])).toBe('aGVsbG8=');
  });

  it('encodes bytes directly', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(call('encode_base64', [bytes])).toBe('AAEC/f7/');
  });

  it('round-trips a string through encode/decode', () => {
    const encoded = call('encode_base64', ['round-trip me']) as string;
    const decoded = call('decode_base64', [encoded]) as Uint8Array;
    expect(new TextDecoder().decode(decoded)).toBe('round-trip me');
  });

  it('round-trips bytes through encode/decode', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 250]);
    const encoded = call('encode_base64', [bytes]) as string;
    const decoded = call('decode_base64', [encoded]) as Uint8Array;
    expect([...decoded]).toEqual([...bytes]);
  });

  it('round-trips unicode content (emoji, accents)', () => {
    const text = 'café 🎉 naïve';
    const encoded = call('encode_base64', [text]) as string;
    const decoded = call('decode_base64', [encoded]) as Uint8Array;
    expect(new TextDecoder().decode(decoded)).toBe(text);
  });

  it('uses the URL-safe alphabet when url_safe: true', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const standard = call('encode_base64', [bytes]) as string;
    const urlSafe = call('encode_base64', [bytes], new Map([['url_safe', true]])) as string;
    expect(standard).toContain('+');
    expect(urlSafe).not.toContain('+');
    expect(urlSafe).not.toContain('/');
    const decoded = call('decode_base64', [urlSafe], new Map([['url_safe', true]])) as Uint8Array;
    expect([...decoded]).toEqual([...bytes]);
  });

  it('fails encode_base64 for a mismatched argument type', () => {
    const result = call('encode_base64', [42n]);
    expect(isFailure(result)).toBe(true);
  });

  it('fails decode_base64 on invalid base64 input', () => {
    const result = call('decode_base64', ['not!valid!base64!']);
    expect(isFailure(result)).toBe(true);
  });
});

describe('encode_hex / decode_hex', () => {
  it('encodes a string as UTF-8 hex', () => {
    expect(call('encode_hex', ['hi'])).toBe('6869');
  });

  it('encodes bytes directly', () => {
    expect(call('encode_hex', [new Uint8Array([0xde, 0xad, 0xbe, 0xef])])).toBe('deadbeef');
  });

  it('round-trips a string through encode/decode', () => {
    const encoded = call('encode_hex', ['round-trip me']) as string;
    const decoded = call('decode_hex', [encoded]) as Uint8Array;
    expect(new TextDecoder().decode(decoded)).toBe('round-trip me');
  });

  it('round-trips bytes through encode/decode', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250]);
    const encoded = call('encode_hex', [bytes]) as string;
    const decoded = call('decode_hex', [encoded]) as Uint8Array;
    expect([...decoded]).toEqual([...bytes]);
  });

  it('round-trips unicode content', () => {
    const text = '日本語 🍣';
    const encoded = call('encode_hex', [text]) as string;
    const decoded = call('decode_hex', [encoded]) as Uint8Array;
    expect(new TextDecoder().decode(decoded)).toBe(text);
  });

  it('fails encode_hex for a mismatched argument type', () => {
    expect(isFailure(call('encode_hex', [true]))).toBe(true);
  });

  it('fails decode_hex on an odd-length string', () => {
    expect(isFailure(call('decode_hex', ['abc']))).toBe(true);
  });

  it('fails decode_hex on a non-hex character', () => {
    expect(isFailure(call('decode_hex', ['zz'])));
    expect(isFailure(call('decode_hex', ['gg']))).toBe(true);
  });
});

describe('encode_percent / decode_percent', () => {
  it('encodes reserved characters when component: true (default)', () => {
    expect(call('encode_percent', ['a/b?c=d&e f'])).toBe('a%2Fb%3Fc%3Dd%26e%20f');
  });

  it('leaves URI-reserved characters alone when component: false', () => {
    const result = call(
      'encode_percent',
      ['https://example.com/a b?x=1&y=2'],
      new Map([['component', false]]),
    );
    expect(result).toBe('https://example.com/a%20b?x=1&y=2');
  });

  it('round-trips a string through encode/decode', () => {
    const text = 'a b/c?d=e&f';
    const encoded = call('encode_percent', [text]) as string;
    expect(call('decode_percent', [encoded])).toBe(text);
  });

  it('round-trips unicode content (emoji, accents)', () => {
    const text = 'crème brûlée 🍮 100%';
    const encoded = call('encode_percent', [text]) as string;
    expect(call('decode_percent', [encoded])).toBe(text);
  });

  it('fails encode_percent for an unpaired UTF-16 surrogate', () => {
    const result = call('encode_percent', ['\uD800']);
    expect(isFailure(result)).toBe(true);
  });

  it('fails decode_percent on a malformed escape sequence', () => {
    expect(isFailure(call('decode_percent', ['100%']))).toBe(true);
    expect(isFailure(call('decode_percent', ['%zz']))).toBe(true);
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

  it('runs encode_base64 through a compiled program', () => {
    const program = compileSource('.encoded = encode_base64(.payload)!');
    const outcome = program.run(LogEvent.from({ payload: 'hello world' }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('encoded')).toBe('aGVsbG8gd29ybGQ=');
    }
  });

  it('round-trips JSON through encode_json/decode via parse_json', () => {
    const program = compileSource('.text = encode_json(.payload)! \n .parsed = parse_json(.text)!');
    const outcome = program.run(LogEvent.from({ payload: { a: 1, b: 'x' } }));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('parsed')).toEqual(
        new Map<string, Value>([
          ['a', 1n],
          ['b', 'x'],
        ]),
      );
    }
  });
});
