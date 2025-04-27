import type {
  Argument,
  BlockExpr,
  Expr,
  IfExpr,
  MatchArm,
  MatchExpr,
  ObjectLiteral,
  ObjectProperty,
  Pattern,
  Program,
  Statement,
} from './ast.js';
import type { Span } from './source.js';

/**
 * AST traversal helpers for tooling (an LSP's hover/completion/go-to-definition, or a CLI's
 * `ferrule explain`-at-a-position). Not needed by {@link parse}/{@link check} themselves — the
 * checker's own traversal is inlined in `check/checker.ts` for the type information it computes
 * along the way — but a later LSP milestone needs "what AST node is under the cursor" as its
 * first primitive, so it lives here rather than being reimplemented per consumer.
 */

export type AstNode = Program | Statement | Expr | Pattern;

/** The result of {@link findNodeAtOffset}: the innermost node containing `offset`, and its path. */
export interface NodePath {
  /** The innermost (most specific) node whose span contains the offset. */
  readonly node: AstNode;
  /** `node`'s ancestors, outermost first, ending with `node`'s immediate parent. */
  readonly ancestors: readonly AstNode[];
}

function contains(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end;
}

/**
 * Finds the innermost AST node whose span contains `offset`, along with its ancestor chain.
 * Returns `undefined` if `offset` falls outside the program entirely. Ties (e.g. the boundary
 * between two adjacent tokens) favor the node encountered first in a left-to-right, outside-in
 * walk, which is the token to the *left* of the cursor for equal-span-end cases — the usual
 * convention for "what did the user just finish typing."
 */
export function findNodeAtOffset(program: Program, offset: number): NodePath | undefined {
  if (!contains(program.span, offset)) return undefined;
  const ancestors: AstNode[] = [];
  let current: AstNode = program;
  for (;;) {
    const child = firstChildContaining(current, offset);
    if (child === undefined) return { node: current, ancestors };
    ancestors.push(current);
    current = child;
  }
}

function firstChildContaining(node: AstNode, offset: number): AstNode | undefined {
  for (const child of childrenOf(node)) {
    if (contains(child.span, offset)) return child;
  }
  return undefined;
}

/** Direct AST children of `node`, in source order. Leaf nodes (literals, identifiers) have none. */
export function childrenOf(node: AstNode): readonly AstNode[] {
  switch (node.kind) {
    case 'program':
      return node.statements;
    case 'exprStatement':
      return [node.expr];
    case 'let':
      return [node.value];
    case 'letCapture':
      return [node.value];
    case 'assign':
      return [node.target, node.value];
    case 'test':
      return [node.given, node.expect];
    case 'array':
      return node.elements;
    case 'object':
      return objectChildren(node);
    case 'unary':
      return [node.operand];
    case 'binary':
      return [node.left, node.right];
    case 'is':
      return [node.subject];
    case 'assert':
      return [node.operand];
    case 'index':
      return [node.target, node.index];
    case 'field':
      return [node.target];
    case 'call':
      return [node.callee, ...argumentChildren(node.args)];
    case 'closure':
      return [node.body];
    case 'if':
      return ifChildren(node);
    case 'match':
      return matchChildren(node);
    case 'block':
      return blockChildren(node);
    case 'abort':
      return node.reason === undefined ? [] : [node.reason];
    case 'string':
      return node.parts.filter((p) => p.kind === 'interpolation').map((p) => p.expr);
    case 'literalPattern':
      return [node.value];
    case 'objectPattern':
    case 'kindPattern':
    case 'regexPattern':
    case 'wildcardPattern':
      return [];
    default:
      return [];
  }
}

function objectChildren(node: ObjectLiteral): readonly AstNode[] {
  return node.properties.map((p: ObjectProperty) => p.value);
}

function argumentChildren(args: readonly Argument[]): readonly AstNode[] {
  return args.map((a) => a.value);
}

function ifChildren(node: IfExpr): readonly AstNode[] {
  const children: AstNode[] = [node.condition, node.thenBranch];
  if (node.elseBranch !== undefined) children.push(node.elseBranch);
  return children;
}

function matchChildren(node: MatchExpr): readonly AstNode[] {
  const children: AstNode[] = [node.subject];
  for (const arm of node.arms) children.push(...matchArmChildren(arm));
  return children;
}

function matchArmChildren(arm: MatchArm): readonly AstNode[] {
  return [arm.pattern, arm.body];
}

function blockChildren(node: BlockExpr): readonly AstNode[] {
  const children: AstNode[] = [...node.statements];
  if (node.result !== undefined) children.push(node.result);
  return children;
}

/**
 * Walks every node in `program`, calling `visit` in a pre-order (parent before children)
 * traversal. Useful for simple analyses that don't need positional lookup (e.g. collecting every
 * `CallExpr`).
 */
export function walkProgram(program: Program, visit: (node: AstNode) => void): void {
  const stack: AstNode[] = [program];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}
