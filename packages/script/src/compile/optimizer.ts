import { LogEvent, Timestamp, wrapInt64 } from '@ferrule/core';
import type { CheckResult, ResolvedCall } from '../check/typedProgram.js';
import type { ImplementationRegistry } from '../registry/implementation.js';
import type { FunctionParam, FunctionSignature } from '../registry/signature.js';
import { DEFAULT_LIMITS } from '../runtime/limits.js';
import { RateLimiter, type RunCtx, type RuntimeValue } from '../runtime/context.js';
import { Failure } from '../runtime/failure.js';
import { dynamicArithmetic, dynamicRelational, runtimeEquals } from '../runtime/ops.js';
import { isRegexValue, RegexValue } from '../runtime/regex.js';
import type { Argument, BlockExpr, CallExpr, Expr, Program, Statement } from '../syntax/ast.js';
import type { Span } from '../syntax/source.js';

const RELATIONAL_OPS = new Set(['<', '<=', '>', '>=']);

interface OptCtx {
  readonly checkResult: CheckResult;
  readonly implementations: ImplementationRegistry;
  /** Start offsets of `let`s the checker flagged unused (W503), for dead-`let` elimination. */
  readonly unusedLetSpans: ReadonlySet<number>;
  /** Every surviving (non-folded) call, keyed by its *rewritten* node; see {@link OptimizedProgram}. */
  readonly calls: Map<CallExpr, ResolvedCall>;
}

export interface OptimizedProgram {
  readonly program: Program;
  /**
   * `checkResult.calls` re-keyed for the rewritten tree: constant folding and dead-branch
   * elimination replace some `CallExpr` nodes with new ones (to fold a call away, or because an
   * ancestor node was rewritten and every node along the way is a fresh object per the standard
   * immutable-AST-rewrite pattern this pass uses), so a lookup by the *original* node's identity
   * would miss. Pass this to `new Compiler(checkResult, implementations, calls)`.
   */
  readonly calls: ReadonlyMap<CallExpr, ResolvedCall>;
}

/**
 * The pre-compilation optimizer (design.md's `resolver → type checker → optimizer → closure
 * compiler` pipeline, docs/architecture.md §5). Rewrites the checked AST bottom-up:
 *
 * - **Constant folding**: a call to a `pure` builtin (no closures, no path argument) with every
 *   argument a literal is evaluated at compile time and replaced with its result, but only when
 *   the call succeeds — a call that would fail (e.g. `1 / 0`) is left alone so its `Failure`
 *   still flows through `??`/`!`/error-capture exactly as the unoptimized program would. The same
 *   applies to arithmetic/comparison/equality operators on two literal operands.
 * - **Dead-branch elimination**: `if` with a literal `bool` condition (including one that just
 *   folded to a literal) is replaced by whichever branch always runs.
 * - **Dead `let` elimination**: a non-`mut` `let` the checker's unused-variable warning (W503)
 *   already flagged is dropped *if* its value is trivially side-effect-free after folding (a
 *   literal, a path/metadata-path read, or a plain variable read) — never a call, which might
 *   have a resource-limit or `emit`/`log` side effect that must still run.
 *
 * Every rewrite preserves the checker's type/call annotations for reused subtrees (they are keyed
 * by AST node identity, and unchanged subtrees are the same node objects) and needs none for new
 * literal nodes this pass creates (the compiler never looks up a type for a literal). See
 * `test/compile/optimizer.test.ts` for the property test checking optimized and unoptimized
 * programs agree on every generated input.
 */
export function optimizeProgram(
  program: Program,
  checkResult: CheckResult,
  implementations: ImplementationRegistry,
): OptimizedProgram {
  const unusedLetSpans = new Set<number>();
  for (const d of checkResult.diagnostics) {
    if (d.code === 'W503') unusedLetSpans.add(d.primary.span.start);
  }
  const calls = new Map<CallExpr, ResolvedCall>();
  const ctx: OptCtx = { checkResult, implementations, unusedLetSpans, calls };
  const statements = optimizeStatements(program.statements, ctx);
  return { program: { ...program, statements }, calls };
}

function optimizeStatements(statements: readonly Statement[], ctx: OptCtx): Statement[] {
  const out: Statement[] = [];
  for (const stmt of statements) {
    const optimized = optimizeStatement(stmt, ctx);
    if (optimized !== undefined) out.push(optimized);
  }
  return out;
}

function optimizeStatement(stmt: Statement, ctx: OptCtx): Statement | undefined {
  switch (stmt.kind) {
    case 'exprStatement':
      return { ...stmt, expr: optimizeExpr(stmt.expr, ctx) };
    case 'let': {
      const value = optimizeExpr(stmt.value, ctx);
      if (!stmt.mutable && ctx.unusedLetSpans.has(stmt.nameSpan.start) && isTriviallyPure(value)) {
        return undefined;
      }
      return { ...stmt, value };
    }
    case 'letCapture':
      return { ...stmt, value: optimizeExpr(stmt.value, ctx) };
    case 'assign':
      return { ...stmt, value: optimizeExpr(stmt.value, ctx) };
    case 'test':
      return stmt;
  }
}

function isTriviallyPure(expr: Expr): boolean {
  switch (expr.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'null':
    case 'rawString':
    case 'byteString':
    case 'timestamp':
    case 'regex':
    case 'path':
    case 'metadataPath':
    case 'identifier':
      return true;
    case 'string':
      return expr.parts.every((p) => p.kind === 'text');
    default:
      return false;
  }
}

function optimizeBlock(block: BlockExpr, ctx: OptCtx): BlockExpr {
  const statements = optimizeStatements(block.statements, ctx);
  const result = block.result !== undefined ? optimizeExpr(block.result, ctx) : undefined;
  return { ...block, statements, result };
}

function optimizeArgument(arg: Argument, ctx: OptCtx): Argument {
  if (arg.value.kind === 'closure') {
    return { ...arg, value: { ...arg.value, body: optimizeExpr(arg.value.body, ctx) } };
  }
  return { ...arg, value: optimizeExpr(arg.value, ctx) };
}

function optimizeExpr(expr: Expr, ctx: OptCtx): Expr {
  switch (expr.kind) {
    case 'string':
      return {
        ...expr,
        parts: expr.parts.map((p) =>
          p.kind === 'text' ? p : { ...p, expr: optimizeExpr(p.expr, ctx) },
        ),
      };
    case 'array':
      return { ...expr, elements: expr.elements.map((e) => optimizeExpr(e, ctx)) };
    case 'object':
      return {
        ...expr,
        properties: expr.properties.map((p) => ({ ...p, value: optimizeExpr(p.value, ctx) })),
      };
    case 'unary': {
      const operand = optimizeExpr(expr.operand, ctx);
      const rewritten = { ...expr, operand };
      return tryFoldUnary(rewritten) ?? rewritten;
    }
    case 'binary': {
      const left = optimizeExpr(expr.left, ctx);
      const right = optimizeExpr(expr.right, ctx);
      const rewritten = { ...expr, left, right };
      return tryFoldBinary(rewritten) ?? rewritten;
    }
    case 'is':
      return { ...expr, subject: optimizeExpr(expr.subject, ctx) };
    case 'assert':
      return { ...expr, operand: optimizeExpr(expr.operand, ctx) };
    case 'index':
      return {
        ...expr,
        target: optimizeExpr(expr.target, ctx),
        index: optimizeExpr(expr.index, ctx),
      };
    case 'field':
      return { ...expr, target: optimizeExpr(expr.target, ctx) };
    case 'call': {
      const resolved = ctx.checkResult.calls.get(expr);
      const args = expr.args.map((a) => optimizeArgument(a, ctx));
      const rewritten: CallExpr = { ...expr, args };
      if (resolved !== undefined) {
        const folded = tryFoldCall(rewritten, resolved.signature, ctx);
        if (folded !== undefined) return folded;
        ctx.calls.set(rewritten, resolved);
      }
      return rewritten;
    }
    case 'if': {
      const condition = optimizeExpr(expr.condition, ctx);
      const thenBranch = optimizeBlock(expr.thenBranch, ctx);
      const elseBranch =
        expr.elseBranch === undefined
          ? undefined
          : expr.elseBranch.kind === 'if'
            ? (optimizeExpr(expr.elseBranch, ctx) as typeof expr.elseBranch)
            : optimizeBlock(expr.elseBranch, ctx);
      if (condition.kind === 'bool') {
        return condition.value ? thenBranch : (elseBranch ?? { kind: 'null', span: expr.span });
      }
      return { ...expr, condition, thenBranch, elseBranch };
    }
    case 'match':
      return {
        ...expr,
        subject: optimizeExpr(expr.subject, ctx),
        arms: expr.arms.map((arm) => ({ ...arm, body: optimizeExpr(arm.body, ctx) })),
      };
    case 'block':
      return optimizeBlock(expr, ctx);
    case 'abort':
      return expr.reason === undefined ? expr : { ...expr, reason: optimizeExpr(expr.reason, ctx) };
    default:
      return expr;
  }
}

// ---- constant folding ---------------------------------------------------------------------------

function constantOf(expr: Expr): RuntimeValue | undefined {
  switch (expr.kind) {
    case 'int':
      return wrapInt64(expr.value);
    case 'float':
      return expr.value;
    case 'bool':
      return expr.value;
    case 'null':
      return null;
    case 'rawString':
      return expr.value;
    case 'byteString':
      return expr.value;
    case 'timestamp':
      return Timestamp.tryParse(expr.text);
    case 'regex':
      return new RegexValue(new RegExp(expr.pattern, expr.flags), expr.pattern, expr.flags);
    case 'string':
      if (expr.parts.length === 0) return '';
      if (expr.parts.length === 1 && expr.parts[0]!.kind === 'text') return expr.parts[0]!.value;
      return undefined;
    default:
      return undefined;
  }
}

function literalOfConstant(value: RuntimeValue, span: Span): Expr | undefined {
  if (value === null) return { kind: 'null', span };
  if (typeof value === 'boolean') return { kind: 'bool', span, value };
  if (typeof value === 'bigint') return { kind: 'int', span, value };
  if (typeof value === 'number') return { kind: 'float', span, value };
  if (typeof value === 'string') {
    return { kind: 'string', span, parts: value.length === 0 ? [] : [{ kind: 'text', value }] };
  }
  if (value instanceof Uint8Array) return { kind: 'byteString', span, value };
  if (value instanceof Timestamp) return { kind: 'timestamp', span, text: value.toISOString() };
  if (isRegexValue(value)) {
    return { kind: 'regex', span, pattern: value.source, flags: value.flags };
  }
  return undefined;
}

function tryFoldUnary(expr: { op: string; operand: Expr; span: Span }): Expr | undefined {
  const v = constantOf(expr.operand);
  if (v === undefined) return undefined;
  if (expr.op === '-') {
    if (typeof v === 'bigint') return literalOfConstant(wrapInt64(-v), expr.span);
    if (typeof v === 'number') return literalOfConstant(-v, expr.span);
    return undefined;
  }
  if (typeof v === 'boolean') return literalOfConstant(!v, expr.span);
  return undefined;
}

function tryFoldBinary(expr: {
  op: string;
  left: Expr;
  right: Expr;
  span: Span;
}): Expr | undefined {
  if (expr.op === '??' || expr.op === '&&' || expr.op === '||') return undefined;
  const l = constantOf(expr.left);
  const r = constantOf(expr.right);
  if (l === undefined || r === undefined) return undefined;
  try {
    if (expr.op === '==') return literalOfConstant(runtimeEquals(l, r), expr.span);
    if (expr.op === '!=') return literalOfConstant(!runtimeEquals(l, r), expr.span);
    if (RELATIONAL_OPS.has(expr.op)) {
      return literalOfConstant(dynamicRelational(expr.op as '<', l, r, expr.span), expr.span);
    }
    const result = dynamicArithmetic(expr.op as '+', l, r, expr.span);
    if (result instanceof Failure) return undefined;
    return literalOfConstant(result, expr.span);
  } catch {
    return undefined;
  }
}

function tryFoldCall(expr: CallExpr, signature: FunctionSignature, ctx: OptCtx): Expr | undefined {
  if (!signature.pure) return undefined;
  if (signature.params.some((p) => p.closure !== undefined || p.requiresPathArgument)) {
    return undefined;
  }
  const implementation = ctx.implementations.get(signature.name);
  if (implementation === undefined) return undefined;

  const slots = new Map<FunctionParam, Argument | undefined>(
    signature.params.map((p) => [p, undefined]),
  );
  const positionalEligible = signature.params.filter((p) => !p.namedOnly);
  let idx = 0;
  for (const arg of expr.args) {
    if (arg.kind === 'positional') {
      const target = positionalEligible[idx];
      idx++;
      if (target !== undefined) slots.set(target, arg);
    } else {
      const target = signature.params.find((p) => p.name === arg.name);
      if (target !== undefined) slots.set(target, arg);
    }
  }

  const positional: RuntimeValue[] = [];
  const positionalSupplied: boolean[] = [];
  const named = new Map<string, RuntimeValue>();
  for (const p of signature.params) {
    const arg = slots.get(p);
    if (p.namedOnly) {
      if (arg === undefined) continue;
      const c = constantOf(arg.value);
      if (c === undefined) return undefined;
      named.set(p.name, c);
      continue;
    }
    if (arg === undefined) {
      positional.push(null);
      positionalSupplied.push(false);
      continue;
    }
    const c = constantOf(arg.value);
    if (c === undefined) return undefined;
    positional.push(c);
    positionalSupplied.push(true);
  }

  let result: RuntimeValue | Failure;
  try {
    result = implementation.call(
      { positional, named, closures: [], positionalSupplied },
      foldRunCtx(),
      expr.span,
    );
  } catch {
    return undefined;
  }
  if (result instanceof Failure) return undefined;
  return literalOfConstant(result, expr.span);
}

function foldRunCtx(): RunCtx {
  return {
    event: new LogEvent(),
    limits: DEFAULT_LIMITS,
    clock: () => Timestamp.now(),
    onLog: () => {},
    logLimiter: new RateLimiter(0),
    emitted: [],
    currentSpan: { start: 0, end: 0 },
  };
}
