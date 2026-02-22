/**
 * Ferrule Script front end: lexer, parser, resolver/type checker, formatter, and diagnostics.
 *
 * See the package README for an overview and `docs/language/design.md` (in the repository root)
 * for the language design this implements. A later milestone's compiler consumes {@link check}'s
 * {@link CheckResult}: walk `result.program` (the same AST `parse` produced) and look up each
 * node's resolved type via `result.types.get(node)` and each call's resolved signature via
 * `result.calls.get(node)`.
 */

import { check as checkProgram } from './check/checker.js';
import { parse as parseSourceFile } from './syntax/parser.js';
import { SourceFile } from './syntax/source.js';
import type { ParseResult } from './syntax/parser.js';

// ---- top-level convenience API -----------------------------------------------------------------

/**
 * Parses Ferrule Script source. Accepts either raw text (wrapped in a {@link SourceFile} named
 * `<script>`, or `name` if given) or an existing {@link SourceFile}. Never throws: syntax errors
 * become diagnostics and the parser still returns the best AST it could recover.
 */
export function parse(source: string | SourceFile, name?: string): ParseResult {
  const file = typeof source === 'string' ? new SourceFile(name ?? '<script>', source) : source;
  return parseSourceFile(file);
}

export { check } from './check/checker.js';

export { format, formatProgram } from './format/formatter.js';

export {
  renderDiagnostic,
  renderDiagnostics,
  summarizeDiagnostic,
  type RenderOptions,
} from './diagnostics/render.js';

/** Parses, then checks, in one call. A convenience for callers that don't need the AST in between. */
export function parseAndCheck(
  source: string | SourceFile,
  options?: Parameters<typeof checkProgram>[1],
): ReturnType<typeof checkProgram> & { readonly parseDiagnostics: ParseResult['diagnostics'] } {
  const { program, diagnostics: parseDiagnostics } = parse(source);
  const result = checkProgram(program, options ?? {});
  return { ...result, parseDiagnostics };
}

// ---- syntax: source positions, tokens, AST -----------------------------------------------------

export { EMPTY_SPAN, joinSpans, SourceFile, type LineColumn, type Span } from './syntax/source.js';

export {
  isKeyword,
  KEYWORDS,
  type ByteStringToken,
  type ErrorToken,
  type FloatToken,
  type IdentifierToken,
  type IntToken,
  type Keyword,
  type MetadataPathToken,
  type PathToken,
  type RawStringToken,
  type RegexToken,
  type SimpleToken,
  type StringPart as TokenStringPart,
  type StringToken,
  type TimestampToken,
  type Token,
  type TokenBase,
  type TokenKind,
} from './syntax/tokens.js';

export {
  lex,
  type CommentTrivia,
  type LexRange,
  type LexResult,
  type LexedToken,
} from './syntax/lexer.js';

export {
  isAssignableSyntax,
  isLiteralExpr,
  NO_TRIVIA,
  type AbortExpr,
  type Argument,
  type ArrayLiteral,
  type AssertExpr,
  type AssignStatement,
  type BinaryExpr,
  type BinaryOp,
  type BlockExpr,
  type BoolLiteral,
  type ByteStringLiteral,
  type CallExpr,
  type ClosureExpr,
  type ClosureParam,
  type DropExpr,
  type ErrorExpr,
  type Expr,
  type ExprStatement,
  type FieldAccessExpr,
  type FloatLiteral,
  type Identifier,
  type IfExpr,
  type IndexExpr,
  type InterpolationPart,
  type IntLiteral,
  type IsExpr,
  type KindPattern,
  type LetCaptureStatement,
  type LetStatement,
  type LiteralPattern,
  type MatchArm,
  type MatchExpr,
  type MetadataPathExpr,
  type NamedArgument,
  type NullLiteral,
  type ObjectLiteral,
  type ObjectPattern,
  type ObjectPatternField,
  type ObjectProperty,
  type PathExpr,
  type Pattern,
  type PositionalArgument,
  type Program,
  type RawStringLiteral,
  type RegexLiteral,
  type RegexPattern,
  type Statement,
  type StringLiteral,
  type StringPart,
  type TestDecl,
  type TimestampLiteral,
  type Trivia,
  type UnaryExpr,
  type UnaryOp,
  type WildcardPattern,
} from './syntax/ast.js';

export type { ParseResult } from './syntax/parser.js';
export { parseExprFragment } from './syntax/parser.js';

export {
  childrenOf,
  findNodeAtOffset,
  walkProgram,
  type AstNode,
  type NodePath,
} from './syntax/query.js';

// ---- diagnostics --------------------------------------------------------------------------------

export {
  DIAGNOSTIC_CATALOG,
  didYouMeanNote,
  explainCode,
  makeDiagnostic,
  type Diagnostic,
  type DiagnosticCatalogEntry,
  type DiagnosticInit,
  type Fix,
  type Label,
  type Severity,
  type TextEdit,
} from './diagnostics/diagnostic.js';

// ---- types --------------------------------------------------------------------------------------

export {
  anyArrayType,
  anyObjectType,
  anyType,
  arrayType,
  boolType,
  bytesType,
  fallibleOf,
  floatType,
  formatExprType,
  formatType,
  handled,
  intType,
  isSubtype,
  joinTypes,
  meetTypes,
  neverType,
  nullType,
  objectType,
  regexType,
  stringType,
  subtractType,
  timestampType,
  typeFromKindName,
  typesEqual,
  unionType,
  withFallibility,
  type ArrayType,
  type ExprType,
  type ObjectType,
  type Type,
  type TypeKind,
  type UnionType,
} from './types/types.js';

// ---- standard library registry -------------------------------------------------------------------

export {
  FunctionRegistry,
  param,
  resolveReturnType,
  type ClosureCallContext,
  type ClosureParamSpec,
  type ClosureSignature,
  type Fallibility,
  type FunctionParam,
  type FunctionSignature,
  type ReturnTypeRule,
} from './registry/signature.js';

export { createDefaultRegistry, registerBuiltins } from './registry/builtins.js';

// ---- resolver / type checker ----------------------------------------------------------------------

export type { CheckOptions, CheckResult, ResolvedCall } from './check/typedProgram.js';
export { didYouMean, editDistance } from './check/editDistance.js';
export { Scope, type Binding } from './check/scope.js';

// ---- compiler / runtime (M2 back end) --------------------------------------------------------

export { compile, type CompileOptions, type CompiledProgram } from './compile/program.js';
export { optimizeProgram } from './compile/optimizer.js';
export { runInlineTests, type FieldDiff, type InlineTestResult } from './compile/testRunner.js';

export {
  impl,
  ImplementationRegistry,
  type BuiltinCall,
  type CallArgs,
  type FunctionImplementation,
} from './registry/implementation.js';

export { assertValue, failure, Failure, isFailure, ScriptBugError } from './runtime/failure.js';
export {
  abortSignal,
  dropSignal,
  limitSignal,
  ScriptSignal,
  type SignalKind,
} from './runtime/signal.js';
export {
  checkCollectionSize,
  checkEmittedEvents,
  checkRegexInputLength,
  checkStringLength,
  DEFAULT_LIMITS,
  resolveLimits,
  type ResourceLimits,
} from './runtime/limits.js';
export type { Outcome } from './runtime/outcome.js';
export {
  createRunCtx,
  RateLimiter,
  type CompiledClosure,
  type Eval,
  type EvalFallible,
  type Exec,
  type Frame,
  type LogSink,
  type RunCtx,
  type RunOptions,
  type RuntimeValue,
} from './runtime/context.js';
export { isRegexValue, RegexValue, assertNoRegex } from './runtime/regex.js';
export { matchesKindName, scriptKindOf, type ScriptKind } from './runtime/kinds.js';
export { toDisplayString, toLiteralString } from './runtime/display.js';
export { formatStrftime, parseStrftime } from './runtime/strftime.js';
export {
  deleteInValue,
  getInValue,
  hasInValue,
  setInValue,
  toPathSegments,
} from './runtime/valuePath.js';

export { createDefaultImplementations, registerStdlib } from './stdlib/index.js';
