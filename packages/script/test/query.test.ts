import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { childrenOf, findNodeAtOffset, parse, walkProgram } from '@ferrule/script';

function programOf(text: string) {
  const { program, diagnostics } = parse(text);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`unexpected diagnostics: ${errors.map((e) => e.code).join(', ')}`);
  }
  return program;
}

describe('findNodeAtOffset', () => {
  it('finds the innermost node under the cursor', () => {
    const program = programOf('let x = 1 + 2');
    // offset inside `2` (the last character)
    const found = findNodeAtOffset(program, 13);
    expect(found).toBeDefined();
    expect(found!.node.kind).toBe('int');
  });

  it('returns the enclosing call for a position on the callee', () => {
    const program = programOf('upcase(.status)');
    const found = findNodeAtOffset(program, 0);
    expect(found!.node.kind).toBe('identifier');
    expect(found!.ancestors.some((a) => a.kind === 'call')).toBe(true);
  });

  it('returns the enclosing block for a position on a nested statement', () => {
    const program = programOf('if true {\n  let x = 1\n}');
    const insideBlockOffset = 'if true {\n  let x = '.length;
    const found = findNodeAtOffset(program, insideBlockOffset);
    expect(found).toBeDefined();
    expect(found!.ancestors.some((a) => a.kind === 'block')).toBe(true);
  });

  it('finds a node inside a match arm', () => {
    const src = 'match x {\n  string => upcase(x) ?? x,\n  _ => x,\n}';
    const program = programOf(src);
    const offset = src.indexOf('upcase') + 1; // inside the first arm's body
    const found = findNodeAtOffset(program, offset);
    expect(found).toBeDefined();
    expect(found!.ancestors.some((a) => a.kind === 'match')).toBe(true);
  });

  it('finds a node inside a string interpolation', () => {
    const program = programOf('"hi {{ name }}"');
    const offset = '"hi {{ '.length;
    const found = findNodeAtOffset(program, offset);
    expect(found).toBeDefined();
    expect(found!.node.kind).toBe('identifier');
  });

  it('returns undefined outside the program span', () => {
    const program = programOf('let x = 1');
    expect(findNodeAtOffset(program, 10_000)).toBeUndefined();
  });

  it('returns the program itself for an offset with no matching child (e.g. an empty program)', () => {
    const program = programOf('');
    const found = findNodeAtOffset(program, 0);
    expect(found).toBeDefined();
    expect(found!.node.kind).toBe('program');
    expect(found!.ancestors).toEqual([]);
  });

  it('the ancestor chain is ordered outermost first', () => {
    const program = programOf('if true { 1 + 2 }');
    const offset = 'if true { 1 + '.length;
    const found = findNodeAtOffset(program, offset)!;
    const kinds = [...found.ancestors.map((a) => a.kind), found.node.kind];
    expect(kinds[0]).toBe('program');
    expect(kinds).toContain('if');
    expect(kinds).toContain('block');
    expect(kinds).toContain('binary');
  });
});

describe('childrenOf / walkProgram', () => {
  it('visits every node reachable from the program, parent before children', () => {
    const program = programOf('let x = 1\nif x { 2 } else { 3 }');
    const kinds: string[] = [];
    walkProgram(program, (n) => kinds.push(n.kind));
    expect(kinds[0]).toBe('program');
    expect(kinds).toContain('let');
    expect(kinds).toContain('if');
    expect(kinds).toContain('block');
    expect(kinds).toContain('int');
  });

  it('has no children for leaf nodes', () => {
    const program = programOf('1');
    const stmt = program.statements[0]!;
    expect(stmt.kind).toBe('exprStatement');
    if (stmt.kind === 'exprStatement') expect(childrenOf(stmt.expr)).toEqual([]);
  });

  it('walks into call arguments, array elements, and object property values', () => {
    const program = programOf('f([1, 2], {"a": 3})');
    const kinds: string[] = [];
    walkProgram(program, (n) => kinds.push(n.kind));
    expect(kinds.filter((k) => k === 'int')).toHaveLength(3);
  });
});

describe('findNodeAtOffset: property — never throws, and every result is well-formed', () => {
  it('handles arbitrary offsets into arbitrary programs without throwing', () => {
    const programs = [
      'let x = 1',
      'if is_string(.a) { upcase(.a) } else { "n/a" }',
      'match x {\n  1 => "a",\n  string => "b",\n  _ => "c",\n}',
      '"hi {{ 1 + 2 }} {{ name }}"',
      'f(1, 2, x: 3)\n|k, v| k + v',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...programs),
        fc.integer({ min: -20, max: 200 }),
        (text, offset) => {
          const program = programOf(text);
          expect(() => findNodeAtOffset(program, offset)).not.toThrow();
          const found = findNodeAtOffset(program, offset);
          if (found !== undefined) {
            // Every reported node's span must actually contain the offset.
            expect(offset).toBeGreaterThanOrEqual(found.node.span.start);
            expect(offset).toBeLessThanOrEqual(found.node.span.end);
          }
        },
      ),
    );
  });
});
