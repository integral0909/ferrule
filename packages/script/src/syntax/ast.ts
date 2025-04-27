import type { Span } from './source.js';
import type { CommentTrivia } from './lexer.js';

/**
 * Ferrule Script's abstract syntax tree.
 *
 * Every node carries a {@link Span}. Nodes are plain discriminated unions (no classes) so they
 * are easy to pattern-match, clone, and serialize. Comments are attached as trivia on the
 * nodes the formatter needs them for (see {@link Trivia}); the type checker and a later
 * compiler can ignore trivia entirely.
 */

export interface Trivia {
  readonly leadingComments: readonly CommentTrivia[];
  readonly trailingComment: CommentTrivia | undefined;
}

export const NO_TRIVIA: Trivia = { leadingComments: [], trailingComment: undefined };

export interface Program {
  readonly kind: 'program';
  readonly span: Span;
  readonly statements: readonly Statement[];
  /** Comments after the last statement (end-of-file trivia), for the formatter. */
  readonly trailingComments: readonly CommentTrivia[];
}

// ---- statements -----------------------------------------------------------------------------

export type Statement =
  ExprStatement | LetStatement | LetCaptureStatement | AssignStatement | TestDecl;

export interface ExprStatement {
  readonly kind: 'exprStatement';
  readonly span: Span;
  readonly trivia: Trivia;
  readonly expr: Expr;
}

export interface LetStatement {
  readonly kind: 'let';
  readonly span: Span;
  readonly trivia: Trivia;
  readonly name: string;
  readonly nameSpan: Span;
  readonly mutable: boolean;
  readonly value: Expr;
}

/** `let v, err = expr` — binds the value and, separately, an error capture. */
export interface LetCaptureStatement {
  readonly kind: 'letCapture';
  readonly span: Span;
  readonly trivia: Trivia;
  readonly valueName: string;
  readonly valueNameSpan: Span;
  readonly errName: string;
  readonly errNameSpan: Span;
  readonly value: Expr;
}

/** Assignment to a path (`.a.b = expr`) or a variable/field/index chain (`x = expr`, `x.a[0] = expr`). */
export interface AssignStatement {
  readonly kind: 'assign';
  readonly span: Span;
  readonly trivia: Trivia;
  readonly target: Expr;
  readonly value: Expr;
}

export interface TestDecl {
  readonly kind: 'test';
  readonly span: Span;
  readonly trivia: Trivia;
  readonly name: string;
  readonly nameSpan: Span;
  readonly given: ObjectLiteral;
  readonly expect: ObjectLiteral;
}

// ---- expressions ------------------------------------------------------------------------------

export type Expr =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | RawStringLiteral
  | ByteStringLiteral
  | TimestampLiteral
  | RegexLiteral
  | BoolLiteral
  | NullLiteral
  | PathExpr
  | MetadataPathExpr
  | Identifier
  | ArrayLiteral
  | ObjectLiteral
  | UnaryExpr
  | BinaryExpr
  | IsExpr
  | AssertExpr
  | IndexExpr
  | FieldAccessExpr
  | CallExpr
  | ClosureExpr
  | IfExpr
  | MatchExpr
  | BlockExpr
  | DropExpr
  | AbortExpr
  | ErrorExpr;

export interface IntLiteral {
  readonly kind: 'int';
  readonly span: Span;
  readonly value: bigint;
}

export interface FloatLiteral {
  readonly kind: 'float';
  readonly span: Span;
  readonly value: number;
}

export type StringPart = { readonly kind: 'text'; readonly value: string } | InterpolationPart;

export interface InterpolationPart {
  readonly kind: 'interpolation';
  readonly span: Span;
  readonly expr: Expr;
}

export interface StringLiteral {
  readonly kind: 'string';
  readonly span: Span;
  readonly parts: readonly StringPart[];
}

export interface RawStringLiteral {
  readonly kind: 'rawString';
  readonly span: Span;
  readonly value: string;
}

export interface ByteStringLiteral {
  readonly kind: 'byteString';
  readonly span: Span;
  readonly value: Uint8Array;
}

/** The raw RFC 3339 text; a compiler resolves it to a `Timestamp` constant at load time. */
export interface TimestampLiteral {
  readonly kind: 'timestamp';
  readonly span: Span;
  readonly text: string;
}

export interface RegexLiteral {
  readonly kind: 'regex';
  readonly span: Span;
  readonly pattern: string;
  readonly flags: string;
}

export interface BoolLiteral {
  readonly kind: 'bool';
  readonly span: Span;
  readonly value: boolean;
}

export interface NullLiteral {
  readonly kind: 'null';
  readonly span: Span;
}

export interface PathExpr {
  readonly kind: 'path';
  readonly span: Span;
  readonly segments: readonly (string | number)[];
}

export interface MetadataPathExpr {
  readonly kind: 'metadataPath';
  readonly span: Span;
  readonly name: string;
}

export interface Identifier {
  readonly kind: 'identifier';
  readonly span: Span;
  readonly name: string;
}

export interface ArrayLiteral {
  readonly kind: 'array';
  readonly span: Span;
  readonly elements: readonly Expr[];
}

export interface ObjectProperty {
  readonly span: Span;
  readonly key: string;
  readonly keySpan: Span;
  readonly value: Expr;
  readonly trivia: Trivia;
}

export interface ObjectLiteral {
  readonly kind: 'object';
  readonly span: Span;
  readonly properties: readonly ObjectProperty[];
}

export type UnaryOp = '-' | '!';

export interface UnaryExpr {
  readonly kind: 'unary';
  readonly span: Span;
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export type BinaryOp =
  '??' | '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

export interface BinaryExpr {
  readonly kind: 'binary';
  readonly span: Span;
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

/** `expr is typeName` — a type test used for flow narrowing, e.g. `.status is string`. */
export interface IsExpr {
  readonly kind: 'is';
  readonly span: Span;
  readonly subject: Expr;
  readonly typeName: string;
  readonly typeNameSpan: Span;
}

/** Postfix `!`: aborts the event if `operand` failed, otherwise yields its handled value. */
export interface AssertExpr {
  readonly kind: 'assert';
  readonly span: Span;
  readonly operand: Expr;
}

export interface IndexExpr {
  readonly kind: 'index';
  readonly span: Span;
  readonly target: Expr;
  readonly index: Expr;
}

export interface FieldAccessExpr {
  readonly kind: 'field';
  readonly span: Span;
  readonly target: Expr;
  readonly name: string;
  readonly nameSpan: Span;
}

export type Argument = PositionalArgument | NamedArgument;

export interface PositionalArgument {
  readonly kind: 'positional';
  readonly span: Span;
  readonly value: Expr;
}

export interface NamedArgument {
  readonly kind: 'named';
  readonly span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  readonly value: Expr;
}

export interface CallExpr {
  readonly kind: 'call';
  readonly span: Span;
  readonly callee: Expr;
  readonly args: readonly Argument[];
}

export interface ClosureParam {
  readonly name: string;
  readonly span: Span;
}

export interface ClosureExpr {
  readonly kind: 'closure';
  readonly span: Span;
  readonly params: readonly ClosureParam[];
  readonly body: Expr;
}

export interface IfExpr {
  readonly kind: 'if';
  readonly span: Span;
  readonly condition: Expr;
  readonly thenBranch: BlockExpr;
  /** A `BlockExpr` for a trailing `else`, a nested `IfExpr` for `else if`, or `undefined`. */
  readonly elseBranch: BlockExpr | IfExpr | undefined;
}

export type Pattern = LiteralPattern | KindPattern | RegexPattern | ObjectPattern | WildcardPattern;

export interface LiteralPattern {
  readonly kind: 'literalPattern';
  readonly span: Span;
  readonly value: IntLiteral | FloatLiteral | StringLiteral | BoolLiteral | NullLiteral;
}

/** A bare type name, e.g. `string`, `int`, `array`, `object`. */
export interface KindPattern {
  readonly kind: 'kindPattern';
  readonly span: Span;
  readonly typeName: string;
}

export interface RegexPattern {
  readonly kind: 'regexPattern';
  readonly span: Span;
  readonly pattern: string;
  readonly flags: string;
}

export interface ObjectPatternField {
  readonly span: Span;
  readonly key: string;
  readonly keySpan: Span;
  /** The local name the field's value is bound to; defaults to `key` when written as shorthand. */
  readonly binding: string;
  readonly bindingSpan: Span;
}

export interface ObjectPattern {
  readonly kind: 'objectPattern';
  readonly span: Span;
  readonly fields: readonly ObjectPatternField[];
  /** Whether the pattern ends with `, ..` to allow (and ignore) extra fields. */
  readonly rest: boolean;
}

export interface WildcardPattern {
  readonly kind: 'wildcardPattern';
  readonly span: Span;
}

export interface MatchArm {
  readonly span: Span;
  readonly trivia: Trivia;
  readonly pattern: Pattern;
  readonly body: Expr;
}

export interface MatchExpr {
  readonly kind: 'match';
  readonly span: Span;
  readonly subject: Expr;
  readonly arms: readonly MatchArm[];
}

export interface BlockExpr {
  readonly kind: 'block';
  readonly span: Span;
  readonly statements: readonly Statement[];
  /** The block's value: its last statement's expression, if it has one and ends without `;`. */
  readonly result: Expr | undefined;
  readonly trailingComments: readonly CommentTrivia[];
}

export interface DropExpr {
  readonly kind: 'drop';
  readonly span: Span;
}

export interface AbortExpr {
  readonly kind: 'abort';
  readonly span: Span;
  readonly reason: Expr | undefined;
}

/** A placeholder produced during error recovery so the parser can keep building a tree. */
export interface ErrorExpr {
  readonly kind: 'error';
  readonly span: Span;
}

// ---- small helpers shared by parser/checker/formatter ----------------------------------------

export function isLiteralExpr(
  expr: Expr,
): expr is IntLiteral | FloatLiteral | StringLiteral | BoolLiteral | NullLiteral {
  return (
    expr.kind === 'int' ||
    expr.kind === 'float' ||
    expr.kind === 'string' ||
    expr.kind === 'bool' ||
    expr.kind === 'null'
  );
}

/** True for expressions that are valid assignment targets at the syntax level. */
export function isAssignableSyntax(expr: Expr): boolean {
  switch (expr.kind) {
    case 'path':
    case 'identifier':
      return true;
    case 'field':
      return isAssignableSyntax(expr.target);
    case 'index':
      return isAssignableSyntax(expr.target);
    default:
      return false;
  }
}
