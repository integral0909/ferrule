import { describe, expect, it } from 'vitest';
import { ComponentRegistry, ShutdownError, UnknownComponentTypeError } from '@ferrule/runtime';
import {
  basicSinkDefinition,
  basicSourceDefinition,
  basicTransformDefinition,
} from './fixtures.js';

describe('ComponentRegistry', () => {
  it('registers and retrieves definitions by kind and type', () => {
    const registry = new ComponentRegistry();
    const source = basicSourceDefinition('http');
    registry.register(source);
    expect(registry.get('source', 'http')).toBe(source);
    expect(registry.has('source', 'http')).toBe(true);
    expect(registry.has('sink', 'http')).toBe(false);
  });

  it('keeps sources, transforms, and sinks in separate namespaces', () => {
    const registry = new ComponentRegistry();
    const source = basicSourceDefinition('shared_name');
    const sink = basicSinkDefinition('shared_name');
    registry.register(source, sink);
    expect(registry.get('source', 'shared_name')).toBe(source);
    expect(registry.get('sink', 'shared_name')).toBe(sink);
  });

  it('rejects registering the same type twice for the same kind', () => {
    const registry = new ComponentRegistry();
    registry.register(basicSourceDefinition('http'));
    expect(() => registry.register(basicSourceDefinition('http'))).toThrow(/already registered/);
  });

  it('throws UnknownComponentTypeError with a did-you-mean suggestion for a near miss', () => {
    const registry = new ComponentRegistry();
    registry.register(basicSourceDefinition('clickhouse'));
    expect(() => registry.get('source', 'clickhous')).toThrow(UnknownComponentTypeError);

    let caught: unknown;
    try {
      registry.get('source', 'clickhous');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownComponentTypeError);
    const typed = caught as UnknownComponentTypeError;
    expect(typed.code).toBe('E_UNKNOWN_COMPONENT_TYPE');
    expect(typed.suggestion).toBe('clickhouse');
  });

  it('gives no suggestion when nothing is close enough', () => {
    const registry = new ComponentRegistry();
    registry.register(basicSourceDefinition('http'));
    let caught: unknown;
    try {
      registry.get('source', 'totally_unrelated_name');
    } catch (error) {
      caught = error;
    }
    expect((caught as UnknownComponentTypeError).suggestion).toBeUndefined();
  });

  it('lists definitions of one kind sorted by type name', () => {
    const registry = new ComponentRegistry();
    registry.register(basicTransformDefinition('zeta'), basicTransformDefinition('alpha'));
    expect(registry.list('transform').map((d) => d.type)).toEqual(['alpha', 'zeta']);
    expect(registry.list('sink')).toEqual([]);
  });
});

describe('ShutdownError', () => {
  it('carries the E_SHUTDOWN code and a sensible default message', () => {
    const error = new ShutdownError();
    expect(error.code).toBe('E_SHUTDOWN');
    expect(error.message).toMatch(/shutting down/);
  });
});
