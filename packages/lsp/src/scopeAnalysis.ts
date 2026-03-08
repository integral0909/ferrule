import {
  findNodeAtOffset,
  type AstNode,
  type BlockExpr,
  type ClosureExpr,
  type Expr,
  type Identifier,
  type IfExpr,
  type MatchArm,
  type MatchExpr,
  type Pattern,
  type Program,
  type Span,
  type Statement,
  type TestDecl,
} from '@ferrule/script';

/**
 * A scope-aware model of `let`/`let mut`/`let v, err`/closure-parameter/object-pattern-field
 * bindings, independent of {@link import('@ferrule/script').CheckResult} (which resolves types but
 * doesn't expose a queryable scope tree). This mirrors `@ferrule/script`'s own checker scoping
 * rules exactly (`check/checker.ts`: a new scope per block, `if`-branch, closure body, match arm,
 * and `test` block; a `let` is visible to statements *after* it in the same scope, never to its
 * own initializer) so that go-to-definition/references/rename/document-highlight and "in-scope
 * variables" completion agree with what the checker itself considers valid.
 *
 * The checker's own `check/scope.ts` `Scope` is deliberately not reused here: it is built and
 * discarded during a single top-down check pass and never keeps position information once
 * checking finishes, whereas an LSP needs to ask "what's visible/resolvable at this arbitrary
 * offset" after the fact, repeatedly, for a document that keeps changing.
 */

export type VariableDeclKind =
  'let' | 'letMut' | 'letCaptureValue' | 'errCapture' | 'closureParam' | 'objectPatternField';

export interface ScopeNode {
  readonly id: number;
  readonly parent: ScopeNode | undefined;
  /** Every binding declared directly in this scope, in source order (including shadowed-over ones). */
  readonly declarations: VariableDecl[];
}

export interface VariableDecl {
  readonly name: string;
  readonly kind: VariableDeclKind;
  readonly mutable: boolean;
  readonly nameSpan: Span;
  readonly scope: ScopeNode;
  /**
   * For `let`/`let v, err = expr`, the initializer expression — `checkResult.typeOf(valueExpr)`
   * gives the binding's type without needing a separate decl→type map. `undefined` for a closure
   * parameter or object-pattern field, whose type instead comes from the call site; look at a
   * {@link VariableReference.node} of this declaration instead (see `variableInfo.ts`).
   */
  readonly valueExpr: Expr | undefined;
}

export interface VariableReference {
  readonly name: string;
  readonly span: Span;
  /** The declaration this reference resolves to, or `undefined` for an undefined-variable use. */
  readonly decl: VariableDecl | undefined;
  /** The `Identifier` expression node this reference came from, for `checkResult.typeOf(node)`. */
  readonly node: Identifier;
  /** `'write'` for the target of `x = expr` (a `let mut` reassignment), `'read'` otherwise. */
  readonly role: 'read' | 'write';
}

export interface ScopeAnalysis {
  readonly root: ScopeNode;
  readonly declarations: readonly VariableDecl[];
  readonly references: readonly VariableReference[];
  /** The innermost scope whose bounding construct (block/closure/arm/test/program) contains `offset`. */
  scopeAt(offset: number): ScopeNode;
  /** The declaration whose name (not its whole binding) contains `offset`, if any. */
  declAt(offset: number): VariableDecl | undefined;
  /** The reference (variable-name use) that contains `offset`, if any. */
  referenceAt(offset: number): VariableReference | undefined;
  referencesOf(decl: VariableDecl): readonly VariableReference[];
  /**
   * Every declaration visible at `offset`: in scope (this scope or an ancestor) and declared
   * textually before it. Nearer declarations shadow farther ones of the same name, matching the
   * checker's own scope lookup.
   */
  visibleAt(offset: number): readonly VariableDecl[];
}

function containsOffset(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end;
}

export function analyzeScopes(program: Program): ScopeAnalysis {
  const declarations: VariableDecl[] = [];
  const references: VariableReference[] = [];
  const scopeOf = new Map<AstNode, ScopeNode>();
  let nextScopeId = 0;

  function newScope(parent: ScopeNode | undefined, boundNode?: AstNode): ScopeNode {
    const scope: ScopeNode = { id: nextScopeId++, parent, declarations: [] };
    if (boundNode !== undefined) scopeOf.set(boundNode, scope);
    return scope;
  }

  function declare(
    scope: ScopeNode,
    name: string,
    kind: VariableDeclKind,
    mutable: boolean,
    nameSpan: Span,
    valueExpr: Expr | undefined = undefined,
  ): void {
    const decl: VariableDecl = { name, kind, mutable, nameSpan, scope, valueExpr };
    scope.declarations.push(decl);
    declarations.push(decl);
  }

  function lookup(scope: ScopeNode, name: string): VariableDecl | undefined {
    let current: ScopeNode | undefined = scope;
    while (current !== undefined) {
      for (let i = current.declarations.length - 1; i >= 0; i--) {
        if (current.declarations[i]!.name === name) return current.declarations[i];
      }
      current = current.parent;
    }
    return undefined;
  }

  function reference(scope: ScopeNode, node: Identifier, role: 'read' | 'write' = 'read'): void {
    references.push({
      name: node.name,
      span: node.span,
      decl: lookup(scope, node.name),
      node,
      role,
    });
  }

  function visitStatements(statements: readonly Statement[], scope: ScopeNode): void {
    for (const stmt of statements) visitStatement(stmt, scope);
  }

  function visitStatement(stmt: Statement, scope: ScopeNode): void {
    switch (stmt.kind) {
      case 'exprStatement':
        visitExpr(stmt.expr, scope);
        return;
      case 'let':
        visitExpr(stmt.value, scope);
        declare(
          scope,
          stmt.name,
          stmt.mutable ? 'letMut' : 'let',
          stmt.mutable,
          stmt.nameSpan,
          stmt.value,
        );
        return;
      case 'letCapture':
        visitExpr(stmt.value, scope);
        declare(scope, stmt.valueName, 'letCaptureValue', false, stmt.valueNameSpan, stmt.value);
        declare(scope, stmt.errName, 'errCapture', false, stmt.errNameSpan);
        return;
      case 'assign':
        visitAssignTarget(stmt.target, scope);
        visitExpr(stmt.value, scope);
        return;
      case 'test':
        visitTest(stmt, scope);
        return;
    }
  }

  function visitAssignTarget(target: Expr, scope: ScopeNode): void {
    switch (target.kind) {
      case 'identifier':
        reference(scope, target, 'write');
        return;
      case 'field':
        visitAssignTarget(target.target, scope);
        return;
      case 'index':
        visitAssignTarget(target.target, scope);
        visitExpr(target.index, scope);
        return;
      default:
        return; // `.path` targets: nothing to resolve
    }
  }

  function visitTest(stmt: TestDecl, scope: ScopeNode): void {
    const testScope = newScope(scope, stmt);
    visitExpr(stmt.given, testScope);
    visitExpr(stmt.expect, testScope);
  }

  function visitExpr(expr: Expr, scope: ScopeNode): void {
    switch (expr.kind) {
      case 'identifier':
        reference(scope, expr);
        return;
      case 'array':
        for (const el of expr.elements) visitExpr(el, scope);
        return;
      case 'object':
        for (const prop of expr.properties) visitExpr(prop.value, scope);
        return;
      case 'unary':
        visitExpr(expr.operand, scope);
        return;
      case 'binary':
        visitExpr(expr.left, scope);
        visitExpr(expr.right, scope);
        return;
      case 'is':
        visitExpr(expr.subject, scope);
        return;
      case 'assert':
        visitExpr(expr.operand, scope);
        return;
      case 'index':
        visitExpr(expr.target, scope);
        visitExpr(expr.index, scope);
        return;
      case 'field':
        visitExpr(expr.target, scope);
        return;
      case 'call':
        // The callee is always a bare function name resolved against the registry, never a
        // variable (`check/checker.ts`'s `checkCall` rejects anything else with E308) — so it is
        // deliberately not visited as a reference here.
        for (const arg of expr.args) visitExpr(arg.value, scope);
        return;
      case 'closure':
        visitClosure(expr, scope);
        return;
      case 'if':
        visitIf(expr, scope);
        return;
      case 'match':
        visitMatch(expr, scope);
        return;
      case 'block':
        visitBlock(expr, newScope(scope, expr));
        return;
      case 'abort':
        if (expr.reason !== undefined) visitExpr(expr.reason, scope);
        return;
      case 'string':
        for (const part of expr.parts) {
          if (part.kind === 'interpolation') visitExpr(part.expr, scope);
        }
        return;
      default:
        return; // literals, paths, metadata paths, `drop`, error-recovery placeholders
    }
  }

  function visitClosure(expr: ClosureExpr, scope: ScopeNode): void {
    const closureScope = newScope(scope, expr);
    for (const p of expr.params) declare(closureScope, p.name, 'closureParam', false, p.span);
    visitExpr(expr.body, closureScope);
  }

  function visitIf(expr: IfExpr, scope: ScopeNode): void {
    visitExpr(expr.condition, scope);
    visitBlock(expr.thenBranch, newScope(scope, expr.thenBranch));
    if (expr.elseBranch === undefined) return;
    if (expr.elseBranch.kind === 'if') visitIf(expr.elseBranch, scope);
    else visitBlock(expr.elseBranch, newScope(scope, expr.elseBranch));
  }

  function visitMatch(expr: MatchExpr, scope: ScopeNode): void {
    visitExpr(expr.subject, scope);
    for (const arm of expr.arms) visitMatchArm(arm, scope);
  }

  function visitMatchArm(arm: MatchArm, scope: ScopeNode): void {
    // `MatchArm` itself isn't an `AstNode` (it's a wrapper `{ pattern, body }`, not something
    // `findNodeAtOffset` ever returns), so the arm's scope is anchored to both of its children —
    // whichever one `scopeAt` actually finds in the offset's ancestor chain.
    const armScope = newScope(scope);
    scopeOf.set(arm.pattern, armScope);
    scopeOf.set(arm.body, armScope);
    visitPattern(arm.pattern, armScope);
    visitExpr(arm.body, armScope);
  }

  function visitPattern(pattern: Pattern, armScope: ScopeNode): void {
    switch (pattern.kind) {
      case 'literalPattern':
        visitExpr(pattern.value, armScope);
        return;
      case 'objectPattern':
        for (const field of pattern.fields) {
          declare(armScope, field.binding, 'objectPatternField', false, field.bindingSpan);
        }
        return;
      default:
        return; // kindPattern, regexPattern, wildcardPattern: no bindings or references
    }
  }

  function visitBlock(block: BlockExpr, scope: ScopeNode): void {
    visitStatements(block.statements, scope);
    if (block.result !== undefined) visitExpr(block.result, scope);
  }

  const root = newScope(undefined, program);
  visitStatements(program.statements, root);

  function scopeAt(offset: number): ScopeNode {
    const path = findNodeAtOffset(program, offset);
    if (path === undefined) return root;
    const chain: AstNode[] = [...path.ancestors, path.node];
    for (let i = chain.length - 1; i >= 0; i--) {
      const scope = scopeOf.get(chain[i]!);
      if (scope !== undefined) return scope;
    }
    return root;
  }

  function declAt(offset: number): VariableDecl | undefined {
    return declarations.find((d) => containsOffset(d.nameSpan, offset));
  }

  function referenceAt(offset: number): VariableReference | undefined {
    return references.find((r) => containsOffset(r.span, offset));
  }

  function referencesOf(decl: VariableDecl): readonly VariableReference[] {
    return references.filter((r) => r.decl === decl);
  }

  function visibleAt(offset: number): readonly VariableDecl[] {
    const result: VariableDecl[] = [];
    const seen = new Set<string>();
    let current: ScopeNode | undefined = scopeAt(offset);
    while (current !== undefined) {
      const byName = new Map<string, VariableDecl>();
      for (const decl of current.declarations) {
        if (decl.nameSpan.end <= offset) byName.set(decl.name, decl);
      }
      for (const decl of byName.values()) {
        if (seen.has(decl.name)) continue;
        seen.add(decl.name);
        result.push(decl);
      }
      current = current.parent;
    }
    return result;
  }

  return { root, declarations, references, scopeAt, declAt, referenceAt, referencesOf, visibleAt };
}
