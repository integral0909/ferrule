import { parse } from '@ferrule/script';
import { describe, expect, it } from 'vitest';
import { analyzeScopes, type ScopeAnalysis } from '@ferrule/lsp';

function scopesOf(source: string): ScopeAnalysis {
  const { program, diagnostics } = parse(source);
  expect(diagnostics.map((d) => d.code)).toEqual([]);
  return analyzeScopes(program);
}

describe('analyzeScopes', () => {
  it('resolves a later reference to an earlier let binding', () => {
    const sa = scopesOf('let x = 1\nlet y = x + 1');
    const xDecl = sa.declarations.find((d) => d.name === 'x')!;
    expect(sa.referencesOf(xDecl)).toHaveLength(1);
    expect(sa.declarations.map((d) => d.name)).toEqual(['x', 'y']);
  });

  it('does not resolve a use before its declaration', () => {
    const sa = scopesOf('let y = x\nlet x = 1');
    const ref = sa.references.find((r) => r.name === 'x')!;
    expect(ref.decl).toBeUndefined();
  });

  it('a let is not visible to its own initializer', () => {
    const sa = scopesOf('let z = z');
    const ref = sa.references.find((r) => r.name === 'z')!;
    expect(ref.decl).toBeUndefined();
  });

  it('an inner scope binding shadows an outer one of the same name', () => {
    const source = 'let x = 1\nif true {\n  let x = 2\n  let y = x\n}';
    const sa = scopesOf(source);
    const [outerX, innerX] = sa.declarations.filter((d) => d.name === 'x');
    expect(outerX).toBeDefined();
    expect(innerX).toBeDefined();
    const xRefInsideIf = sa.references.find(
      (r) => r.name === 'x' && r.span.start > innerX!.nameSpan.start,
    );
    expect(xRefInsideIf?.decl).toBe(innerX);
  });

  it('an if-branch scope does not leak into the other branch or after the if', () => {
    const source = 'if true {\n  let a = 1\n} else {\n  let b = a\n}\nlet c = a';
    const sa = scopesOf(source);
    const bInitRef = sa.references.find(
      (r) => r.name === 'a' && sa.declarations.some((d) => d.name === 'b'),
    );
    expect(bInitRef?.decl).toBeUndefined();
    const cInitRef = sa.references.find(
      (r) => r.name === 'a' && r.span.start === source.lastIndexOf('a'),
    );
    expect(cInitRef?.decl).toBeUndefined();
  });

  it('closure parameters are scoped to the closure body only', () => {
    const sa = scopesOf('let xs = {}\nlet doubled = map_values(xs, |k, v| v)');
    const paramDecl = sa.declarations.find((d) => d.kind === 'closureParam' && d.name === 'v')!;
    expect(paramDecl).toBeDefined();
    expect(sa.referencesOf(paramDecl)).toHaveLength(1);
    // The other closure parameter, `k`, is declared but never referenced.
    const kDecl = sa.declarations.find((d) => d.kind === 'closureParam' && d.name === 'k')!;
    expect(sa.referencesOf(kDecl)).toHaveLength(0);
  });

  it('object-pattern fields in a match arm are scoped to that arm', () => {
    const sa = scopesOf('match .x {\n  { a } => a,\n  _ => 0,\n}');
    const decl = sa.declarations.find((d) => d.kind === 'objectPatternField')!;
    expect(decl.name).toBe('a');
    expect(sa.referencesOf(decl)).toHaveLength(1);
  });

  it('object-pattern rename binding (`key: binding`) uses the binding name, not the key', () => {
    const sa = scopesOf('match .x {\n  { a: renamed } => renamed,\n  _ => 0,\n}');
    const decl = sa.declarations.find((d) => d.kind === 'objectPatternField')!;
    expect(decl.name).toBe('renamed');
  });

  it('`let v, err = expr` declares both the value and the error capture', () => {
    const sa = scopesOf('let v, err = to_int(.x)\nlet y = v');
    expect(sa.declarations.map((d) => d.name)).toEqual(expect.arrayContaining(['v', 'err']));
    const errDecl = sa.declarations.find((d) => d.name === 'err')!;
    expect(errDecl.kind).toBe('errCapture');
    const valueDecl = sa.declarations.find((d) => d.name === 'v')!;
    expect(valueDecl.kind).toBe('letCaptureValue');
  });

  it('a reassignment of a `let mut` variable is recorded as a write reference', () => {
    const sa = scopesOf('let mut x = 1\nx = 2');
    const writeRef = sa.references.find((r) => r.role === 'write')!;
    expect(writeRef.name).toBe('x');
    const decl = sa.declarations.find((d) => d.name === 'x')!;
    expect(decl.mutable).toBe(true);
  });

  it('visibleAt returns only same-or-outer-scope declarations made before the offset', () => {
    const source = 'let a = 1\nlet b = 2\nif true {\n  let c = 3\n}\nlet d = 4';
    const sa = scopesOf(source);
    const beforeD = source.indexOf('let d');
    const visible = sa
      .visibleAt(beforeD)
      .map((d) => d.name)
      .sort();
    expect(visible).toEqual(['a', 'b']);
  });

  it('visibleAt inside a block also sees outer-scope bindings declared before the block', () => {
    const source = 'let a = 1\nif true {\n  let b = 2\n}';
    const sa = scopesOf(source);
    const insideBlock = source.indexOf('let b') + 2;
    expect(sa.visibleAt(insideBlock).map((d) => d.name)).toEqual(['a']);
  });

  it('scopeAt resolves a nested scope, distinct from the root, for an offset inside a block', () => {
    const source = 'if true {\n  let inner = 1\n}';
    const sa = scopesOf(source);
    const scope = sa.scopeAt(source.indexOf('inner'));
    expect(scope).not.toBe(sa.root);
    expect(scope.parent).toBe(sa.root);
  });

  it('declAt finds the declaration whose name span contains the offset', () => {
    const source = 'let x = 1\nlet y = x';
    const sa = scopesOf(source);
    expect(sa.declAt(source.indexOf('x'))?.name).toBe('x');
    expect(sa.declAt(source.indexOf('y'))?.name).toBe('y');
  });

  it('referenceAt finds the reference whose span contains the offset', () => {
    const source = 'let x = 1\nlet y = x';
    const sa = scopesOf(source);
    const useOffset = source.lastIndexOf('x');
    const ref = sa.referenceAt(useOffset);
    expect(ref?.name).toBe('x');
    expect(ref?.decl?.name).toBe('x');
  });

  it('an undefined variable reference has no resolved declaration', () => {
    const sa = scopesOf('let y = undefined_name');
    const ref = sa.references.find((r) => r.name === 'undefined_name')!;
    expect(ref.decl).toBeUndefined();
  });
});
