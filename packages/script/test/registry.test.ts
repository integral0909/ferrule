import { describe, expect, it } from 'vitest';
import {
  anyType,
  createDefaultRegistry,
  FunctionRegistry,
  formatType,
  intType,
  param,
  resolveReturnType,
  stringType,
} from '@ferrule/script';

describe('FunctionRegistry', () => {
  it('registers and looks up signatures', () => {
    const registry = new FunctionRegistry();
    registry.register({
      name: 'double',
      params: [param('x', intType)],
      returnType: intType,
      fallible: 'never',
      pure: true,
      docs: 'doubles an int',
      examples: [],
    });
    expect(registry.has('double')).toBe(true);
    expect(registry.get('double')?.name).toBe('double');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.names()).toEqual(['double']);
  });

  it('rejects re-registering the same name', () => {
    const registry = new FunctionRegistry();
    const sig = {
      name: 'f',
      params: [],
      returnType: intType,
      fallible: 'never' as const,
      pure: true,
      docs: '',
      examples: [],
    };
    registry.register(sig);
    expect(() => registry.register(sig)).toThrow();
  });
});

describe('builtin registry', () => {
  const registry = createDefaultRegistry();
  const expected = [
    'del',
    'downcase',
    'emit',
    'exists',
    'filter',
    'is_int',
    'is_string',
    'length',
    'map_values',
    'now',
    'parse_json',
    'parse_regex',
    'to_int',
    'to_string',
    'upcase',
  ];

  it('registers every function required by the milestone', () => {
    for (const name of expected) expect(registry.has(name)).toBe(true);
  });

  it('gives every signature docs and a stable fallibility mode', () => {
    for (const sig of registry.all()) {
      expect(sig.docs.length).toBeGreaterThan(0);
      expect(['always', 'on-argument-mismatch', 'never']).toContain(sig.fallible);
    }
  });

  it('marks del/exists as requiring a path argument', () => {
    expect(registry.get('del')?.params[0]?.requiresPathArgument).toBe(true);
    expect(registry.get('exists')?.params[0]?.requiresPathArgument).toBe(true);
  });

  it('computes map_values return type from the closure return type', () => {
    const sig = registry.get('map_values')!;
    const returned = resolveReturnType(
      sig,
      [
        { type: anyType, fallible: false },
        { type: anyType, fallible: false },
      ],
      { closureReturn: { type: stringType, fallible: false } },
    );
    expect(formatType(returned)).toBe('object { ..string }');
  });

  it('computes filter return type by echoing the input array type', () => {
    const sig = registry.get('filter')!;
    const inputType = { type: { kind: 'array' as const, element: stringType }, fallible: false };
    const returned = resolveReturnType(sig, [inputType, { type: anyType, fallible: false }], {
      closureReturn: undefined,
    });
    expect(formatType(returned)).toBe('array<string>');
  });

  it('marks parse_json and to_int as always fallible', () => {
    expect(registry.get('parse_json')?.fallible).toBe('always');
    expect(registry.get('to_int')?.fallible).toBe('always');
  });

  it('marks to_string/is_string/is_int/now as never fallible', () => {
    for (const name of ['to_string', 'is_string', 'is_int', 'now']) {
      expect(registry.get(name)?.fallible).toBe('never');
    }
  });
});
