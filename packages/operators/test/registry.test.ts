import { describe, expect, it } from 'vitest';
import { ComponentRegistry } from '@ferrule/runtime';
import { builtinOperators } from '@ferrule/operators';

describe('builtinOperators', () => {
  it('lists fifteen transforms with unique type names', () => {
    const operators = builtinOperators();
    expect(operators).toHaveLength(15);
    expect(new Set(operators.map((o) => o.type)).size).toBe(15);
  });

  it('every operator declares a non-empty description and at least one accepted kind', () => {
    for (const op of builtinOperators()) {
      expect(op.description.length).toBeGreaterThan(0);
      expect(op.accepts.length).toBeGreaterThan(0);
    }
  });

  it('registers cleanly into a ComponentRegistry without type collisions', () => {
    const registry = new ComponentRegistry();
    registry.register(...builtinOperators());
    for (const op of builtinOperators()) {
      expect(registry.has('transform', op.type)).toBe(true);
    }
  });

  it('every example config parses against its own options schema', () => {
    for (const op of builtinOperators()) {
      for (const example of op.examples ?? []) {
        const result = op.options.safeParse(example.config);
        expect({
          type: op.type,
          title: example.title,
          ok: result.ok,
          issues: result.ok ? [] : result.issues,
        }).toEqual({ type: op.type, title: example.title, ok: true, issues: [] });
      }
    }
  });
});
