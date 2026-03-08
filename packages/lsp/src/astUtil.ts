import {
  findNodeAtOffset,
  type AstNode,
  type CallExpr,
  type CheckResult,
  type Expr,
  type ExprType,
  type NodePath,
  type Program,
} from '@ferrule/script';

/** Every `Expr['kind']` value, for narrowing a generic {@link AstNode} down to an {@link Expr}. */
const EXPR_KINDS: ReadonlySet<string> = new Set([
  'int',
  'float',
  'string',
  'rawString',
  'byteString',
  'timestamp',
  'regex',
  'bool',
  'null',
  'path',
  'metadataPath',
  'identifier',
  'array',
  'object',
  'unary',
  'binary',
  'is',
  'assert',
  'index',
  'field',
  'call',
  'closure',
  'if',
  'match',
  'block',
  'drop',
  'abort',
  'error',
]);

export function asExpr(node: AstNode): Expr | undefined {
  return EXPR_KINDS.has(node.kind) ? (node as Expr) : undefined;
}

/** `path.ancestors` (outermost first) followed by `path.node` itself. */
export function nodeChain(path: NodePath): readonly AstNode[] {
  return [...path.ancestors, path.node];
}

/**
 * The innermost `Expr` at or enclosing `offset` that the checker recorded a type for — climbing
 * past nodes {@link CheckResult.types} has no entry for (statements, patterns, a call's callee
 * identifier, error-recovery placeholders). Used by hover's "type of the expression under the
 * cursor".
 */
export function findTypedExprAt(
  program: Program,
  offset: number,
  checkResult: CheckResult,
): { readonly expr: Expr; readonly type: ExprType } | undefined {
  const path = findNodeAtOffset(program, offset);
  if (path === undefined) return undefined;
  const chain = nodeChain(path);
  for (let i = chain.length - 1; i >= 0; i--) {
    const expr = asExpr(chain[i]!);
    if (expr === undefined) continue;
    const type = checkResult.types.get(expr);
    if (type !== undefined) return { expr, type };
  }
  return undefined;
}

/** The call whose *function name* (not its arguments) contains `offset`, for hover-over-a-call-name. */
export function findCallNameAt(program: Program, offset: number): CallExpr | undefined {
  const path = findNodeAtOffset(program, offset);
  if (path === undefined) return undefined;
  const chain = nodeChain(path);
  for (let i = chain.length - 1; i >= 1; i--) {
    const node = chain[i]!;
    const parent = chain[i - 1]!;
    if (node.kind === 'identifier' && parent.kind === 'call' && parent.callee === node) {
      return parent;
    }
  }
  return undefined;
}

/** The innermost call whose full span (name through closing paren) contains `offset`. */
export function findEnclosingCall(program: Program, offset: number): CallExpr | undefined {
  const path = findNodeAtOffset(program, offset);
  if (path === undefined) return undefined;
  const chain = nodeChain(path);
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    if (node.kind === 'call') return node;
  }
  return undefined;
}
