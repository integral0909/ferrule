import {
  deletePath,
  getPath,
  hasPath,
  setPath,
  Timestamp,
  wrapInt64,
  type PathSegment,
  type Value,
} from '@ferrule/core';
import type { CheckResult, ResolvedCall } from '../check/typedProgram.js';
import type { ImplementationRegistry } from '../registry/implementation.js';
import type { ClosureSignature, FunctionParam } from '../registry/signature.js';
import { toDisplayString } from '../runtime/display.js';
import { assertValue, Failure, ScriptBugError } from '../runtime/failure.js';
import { matchesKindName } from '../runtime/kinds.js';
import { checkCollectionSize, checkStringLength } from '../runtime/limits.js';
import {
  dynamicArithmetic,
  dynamicRelational,
  floatArithmetic,
  intArithmetic,
  runtimeEquals,
} from '../runtime/ops.js';
import { assertNoRegex, isRegexValue, RegexValue } from '../runtime/regex.js';
import type {
  CompiledClosure,
  Eval,
  EvalFallible,
  Exec,
  Frame,
  RunCtx,
  RuntimeValue,
} from '../runtime/context.js';
import { abortSignal, dropSignal } from '../runtime/signal.js';
import { setInValue } from '../runtime/valuePath.js';
import type {
  Argument,
  AssignStatement,
  BinaryExpr,
  BlockExpr,
  BoolLiteral,
  CallExpr,
  Expr,
  FloatLiteral,
  Identifier,
  IfExpr,
  IntLiteral,
  MatchExpr,
  NullLiteral,
  Pattern,
  Statement,
  StringLiteral,
  UnaryExpr,
} from '../syntax/ast.js';
import type { Span } from '../syntax/source.js';
import { SlotAllocator, type CompileScope } from './scope.js';

const RELATIONAL_OPS = new Set(['<', '<=', '>', '>=']);
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '%']);

/**
 * Turns a checked program into a tree of pre-specialised closures. See the README's "Compiler
 * architecture" section for the overall design (frames instead of a second interpreter stack,
 * `Failure` sentinels vs. `ScriptSignal` exceptions, the `any`-operand abort policy). One
 * `Compiler` instance compiles one program: it owns the shared {@link SlotAllocator} every `let`,
 * closure parameter, and match binding draws from.
 */
export class Compiler {
  readonly alloc = new SlotAllocator();
  private readonly calls: ReadonlyMap<CallExpr, ResolvedCall>;

  /**
   * `calls` defaults to `checkResult.calls`, which is only valid for `checkResult.program`
   * itself. When compiling an *optimized* program (`compile/optimizer.ts`), pass the calls map
   * `optimizeProgram` returns instead: constant folding and dead-branch elimination replace some
   * `CallExpr` nodes with new ones (to fold, or because an ancestor was rewritten), and
   * `checkResult.calls` is keyed by the original nodes' identity, not the rewritten ones'.
   */
  constructor(
    private readonly checkResult: CheckResult,
    private readonly implementations: ImplementationRegistry,
    calls?: ReadonlyMap<CallExpr, ResolvedCall>,
  ) {
    this.calls = calls ?? checkResult.calls;
  }

  // ---- statements -----------------------------------------------------------------------------

  compileStatements(statements: readonly Statement[], scope: CompileScope): Exec[] {
    return statements.map((stmt) => this.compileStatement(stmt, scope));
  }

  private compileStatement(stmt: Statement, scope: CompileScope): Exec {
    switch (stmt.kind) {
      case 'exprStatement': {
        const c = this.compileHandled(stmt.expr, scope);
        const span = stmt.span;
        return (frame, ctx) => {
          ctx.currentSpan = span;
          c(frame, ctx);
        };
      }
      case 'let': {
        const c = this.compileHandled(stmt.value, scope);
        const slot = scope.declare(stmt.name);
        const span = stmt.span;
        return (frame, ctx) => {
          ctx.currentSpan = span;
          frame[slot] = c(frame, ctx);
        };
      }
      case 'letCapture': {
        const c = this.compile(stmt.value, scope);
        const valueSlot = scope.declare(stmt.valueName);
        const errSlot = scope.declare(stmt.errName);
        const span = stmt.span;
        return (frame, ctx) => {
          ctx.currentSpan = span;
          const r = c(frame, ctx);
          if (r instanceof Failure) {
            frame[valueSlot] = null;
            frame[errSlot] = r.message;
          } else {
            frame[valueSlot] = r;
            frame[errSlot] = null;
          }
        };
      }
      case 'assign':
        return this.compileAssign(stmt, scope);
      case 'test':
        // No-op during a normal run; `compile/testRunner.ts` compiles and runs test blocks itself.
        return () => {};
    }
  }

  private compileAssign(stmt: AssignStatement, scope: CompileScope): Exec {
    const setter = this.compileAssignTarget(stmt.target, scope);
    const value = this.compileHandled(stmt.value, scope);
    const span = stmt.span;
    return (frame, ctx) => {
      ctx.currentSpan = span;
      setter(frame, ctx, value(frame, ctx));
    };
  }

  private compileAssignTarget(
    target: Expr,
    scope: CompileScope,
  ): (frame: Frame, ctx: RunCtx, value: RuntimeValue) => void {
    if (target.kind === 'path') {
      const segments = target.segments;
      const span = target.span;
      return (_frame, ctx, value) => {
        setPath(ctx.event.fields, segments, assertNoRegex(value, span));
      };
    }
    if (target.kind === 'identifier') {
      const slot = scope.resolve(target.name);
      return (frame, _ctx, value) => {
        frame[slot] = value;
      };
    }
    const { slot, parts } = this.resolveNestedChain(target, scope);
    const span = target.span;
    return (frame, ctx, value) => {
      const root = frame[slot];
      if (isRegexValue(root)) {
        throw abortSignal('cannot assign into a field or index of a regex value', span);
      }
      const segments = parts.map((p) => p(frame, ctx));
      frame[slot] = setInValue(root as Value, segments, assertNoRegex(value, span));
    };
  }

  private resolveNestedChain(
    target: Expr,
    scope: CompileScope,
  ): { slot: number; parts: Array<(frame: Frame, ctx: RunCtx) => PathSegment> } {
    if (target.kind === 'identifier') return { slot: scope.resolve(target.name), parts: [] };
    if (target.kind === 'field') {
      const inner = this.resolveNestedChain(target.target, scope);
      const name = target.name;
      inner.parts.push(() => name);
      return inner;
    }
    if (target.kind === 'index') {
      const inner = this.resolveNestedChain(target.target, scope);
      const idxEval = this.compileHandled(target.index, scope);
      const span = target.index.span;
      inner.parts.push((frame, ctx) => toPathSegmentRuntime(idxEval(frame, ctx), span));
      return inner;
    }
    throw new ScriptBugError('internal error: invalid assignment target', target.span);
  }

  // ---- expressions ------------------------------------------------------------------------------

  /**
   * Compiles an expression the checker guarantees cannot fail (its `typeOf(expr).fallible` is
   * `false`). By construction, the closure {@link compile} produces for such an expression never
   * constructs a `Failure` — every AST kind that can fail (calls, `/`/`%`, indexing) is fallible
   * in the checker's own types whenever it can actually fail — so this is a zero-cost re-typing,
   * not a runtime check. See the README's "Compiler architecture" for why that invariant holds.
   */
  compileHandled(expr: Expr, scope: CompileScope): Eval {
    return this.compile(expr, scope) as Eval;
  }

  compile(expr: Expr, scope: CompileScope): EvalFallible {
    switch (expr.kind) {
      case 'int':
        return this.compileIntLiteral(expr);
      case 'float':
        return this.compileFloatLiteral(expr);
      case 'bool':
        return this.compileBoolLiteral(expr);
      case 'null':
        return this.compileNullLiteral(expr);
      case 'rawString': {
        const v = expr.value;
        return () => v;
      }
      case 'byteString': {
        const v = expr.value;
        return () => v;
      }
      case 'timestamp': {
        const v = Timestamp.parse(expr.text);
        return () => v;
      }
      case 'regex': {
        const v = new RegexValue(new RegExp(expr.pattern, expr.flags), expr.pattern, expr.flags);
        return () => v;
      }
      case 'string':
        return this.compileStringLiteral(expr, scope);
      case 'path':
        return this.compilePath(expr.segments);
      case 'metadataPath':
        return this.compileMetadataPath(expr.name);
      case 'identifier':
        return this.compileIdentifier(expr, scope);
      case 'array':
        return this.compileArrayLiteral(expr.elements, scope, expr.span);
      case 'object':
        return this.compileObjectLiteral(expr.properties, scope, expr.span);
      case 'unary':
        return this.compileUnary(expr, scope);
      case 'binary':
        return this.compileBinary(expr, scope);
      case 'is':
        return this.compileIs(expr.subject, expr.typeName, scope);
      case 'assert':
        return this.compileAssert(expr.operand, expr.span, scope);
      case 'index':
        return this.compileIndex(expr.target, expr.index, expr.span, scope);
      case 'field':
        return this.compileField(expr.target, expr.name, expr.span, scope);
      case 'call':
        return this.compileCall(expr, scope);
      case 'closure':
        throw new ScriptBugError('internal error: a stray closure reached the compiler', expr.span);
      case 'if':
        return this.compileIf(expr, scope);
      case 'match':
        return this.compileMatch(expr, scope);
      case 'block':
        return this.compileBlock(expr, scope.child());
      case 'drop':
        return () => {
          throw dropSignal(expr.span);
        };
      case 'abort':
        return this.compileAbort(expr.reason, expr.span, scope);
      case 'error':
        throw new ScriptBugError(
          'internal error: cannot compile a program with parse errors',
          expr.span,
        );
    }
  }

  private compileIntLiteral(expr: IntLiteral): Eval {
    const v = wrapInt64(expr.value);
    return () => v;
  }

  private compileFloatLiteral(expr: FloatLiteral): Eval {
    const v = expr.value;
    return () => v;
  }

  private compileBoolLiteral(expr: BoolLiteral): Eval {
    const v = expr.value;
    return () => v;
  }

  private compileNullLiteral(_expr: NullLiteral): Eval {
    return () => null;
  }

  private compileStringLiteral(expr: StringLiteral, scope: CompileScope): Eval {
    if (expr.parts.length === 0) return () => '';
    if (expr.parts.length === 1 && expr.parts[0]!.kind === 'text') {
      const v = expr.parts[0]!.value;
      return () => v;
    }
    const parts = expr.parts.map((p) =>
      p.kind === 'text'
        ? { text: p.value, eval: undefined }
        : { text: undefined, eval: this.compileHandled(p.expr, scope) },
    );
    const span = expr.span;
    return (frame, ctx) => {
      let out = '';
      for (const p of parts) {
        out += p.text !== undefined ? p.text : toDisplayString(p.eval(frame, ctx));
      }
      checkStringLength(out.length, ctx.limits, span);
      return out;
    };
  }

  private compilePath(segments: readonly PathSegment[]): Eval {
    if (segments.length === 0) return (_frame, ctx) => ctx.event.fields;
    return (_frame, ctx) => getPath(ctx.event.fields, segments) ?? null;
  }

  private compileMetadataPath(name: string): Eval {
    switch (name) {
      case 'source_id':
        return (_frame, ctx) => ctx.event.metadata.sourceId ?? null;
      case 'source_type':
        return (_frame, ctx) => ctx.event.metadata.sourceType ?? null;
      case 'received_at':
        return (_frame, ctx) => ctx.event.metadata.receivedAt;
      default:
        return () => null;
    }
  }

  private compileIdentifier(expr: Identifier, scope: CompileScope): Eval {
    const slot = scope.resolve(expr.name);
    return (frame) => frame[slot]!;
  }

  private compileArrayLiteral(elements: readonly Expr[], scope: CompileScope, span: Span): Eval {
    const compiled = elements.map((e) => this.compileHandled(e, scope));
    return (frame, ctx) => {
      const out: RuntimeValue[] = new Array<RuntimeValue>(compiled.length);
      for (let i = 0; i < compiled.length; i++) out[i] = compiled[i]!(frame, ctx);
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    };
  }

  private compileObjectLiteral(
    properties: readonly { key: string; value: Expr }[],
    scope: CompileScope,
    span: Span,
  ): Eval {
    const compiled = properties.map((p) => ({
      key: p.key,
      eval: this.compileHandled(p.value, scope),
    }));
    return (frame, ctx) => {
      const out = new Map<string, RuntimeValue>();
      for (const p of compiled) out.set(p.key, p.eval(frame, ctx));
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    };
  }

  // ---- operators ----------------------------------------------------------------------------

  private compileUnary(expr: UnaryExpr, scope: CompileScope): Eval {
    const operandType = this.checkResult.typeOf(expr.operand).type;
    const operand = this.compileHandled(expr.operand, scope);
    const span = expr.span;
    if (expr.op === '-') {
      if (operandType.kind === 'int') {
        return (frame, ctx) => wrapInt64(-(operand(frame, ctx) as bigint));
      }
      if (operandType.kind === 'float') {
        return (frame, ctx) => -(operand(frame, ctx) as number);
      }
      return (frame, ctx) => {
        const v = operand(frame, ctx);
        if (typeof v === 'bigint') return wrapInt64(-v);
        if (typeof v === 'number') return -v;
        throw abortSignal(`cannot apply unary '-' to ${describeRuntimeKind(v)}`, span);
      };
    }
    // '!'
    if (operandType.kind === 'bool') {
      return (frame, ctx) => !(operand(frame, ctx) as boolean);
    }
    return (frame, ctx) => {
      const v = operand(frame, ctx);
      if (typeof v === 'boolean') return !v;
      throw abortSignal(`cannot apply unary '!' to ${describeRuntimeKind(v)}`, span);
    };
  }

  private compileBinary(expr: BinaryExpr, scope: CompileScope): EvalFallible {
    if (expr.op === '??') return this.compileCoalesce(expr.left, expr.right, scope);
    if (expr.op === '&&' || expr.op === '||') return this.compileLogical(expr, scope);

    const leftType = this.checkResult.typeOf(expr.left).type;
    const rightType = this.checkResult.typeOf(expr.right).type;
    const left = this.compileHandled(expr.left, scope);
    const right = this.compileHandled(expr.right, scope);
    const span = expr.span;

    if (expr.op === '==' || expr.op === '!=') {
      const negate = expr.op === '!=';
      return (frame, ctx) => {
        const eq = runtimeEquals(left(frame, ctx), right(frame, ctx));
        return negate ? !eq : eq;
      };
    }

    if (RELATIONAL_OPS.has(expr.op)) {
      if (leftType.kind === 'int' && rightType.kind === 'int') {
        const cmp = bigintRelational(expr.op);
        return (frame, ctx) => cmp(left(frame, ctx) as bigint, right(frame, ctx) as bigint);
      }
      if (leftType.kind === 'float' && rightType.kind === 'float') {
        const cmp = numberRelational(expr.op);
        return (frame, ctx) => cmp(left(frame, ctx) as number, right(frame, ctx) as number);
      }
      if (leftType.kind === 'string' && rightType.kind === 'string') {
        const cmp = stringRelational(expr.op);
        return (frame, ctx) => cmp(left(frame, ctx) as string, right(frame, ctx) as string);
      }
      return (frame, ctx) => dynamicRelational(expr.op, left(frame, ctx), right(frame, ctx), span);
    }

    // Arithmetic: + - * / %
    if (ARITHMETIC_OPS.has(expr.op)) {
      return this.compileArithmetic(expr.op, leftType.kind, rightType.kind, left, right, span);
    }
    throw new ScriptBugError(`internal error: unhandled binary operator '${expr.op}'`, span);
  }

  private compileArithmetic(
    op: BinaryExpr['op'],
    leftKind: string,
    rightKind: string,
    left: Eval,
    right: Eval,
    span: Span,
  ): EvalFallible {
    const isDivMod = op === '/' || op === '%';
    if (leftKind === 'int' && rightKind === 'int') {
      if (isDivMod) {
        return (frame, ctx) =>
          intArithmetic(op, left(frame, ctx) as bigint, right(frame, ctx) as bigint);
      }
      return (frame, ctx) => {
        const r = intArithmetic(op, left(frame, ctx) as bigint, right(frame, ctx) as bigint);
        return assertValue(r, span);
      };
    }
    if (leftKind === 'float' && rightKind === 'float') {
      return (frame, ctx) =>
        floatArithmetic(op, left(frame, ctx) as number, right(frame, ctx) as number);
    }
    if (op === '+' && leftKind === 'string' && rightKind === 'string') {
      return (frame, ctx) => {
        const s = (left(frame, ctx) as string) + (right(frame, ctx) as string);
        checkStringLength(s.length, ctx.limits, span);
        return s;
      };
    }
    // Dynamic (`any`-typed) fallback.
    if (isDivMod) {
      return (frame, ctx) => dynamicArithmetic(op, left(frame, ctx), right(frame, ctx), span);
    }
    return (frame, ctx) => {
      const r = dynamicArithmetic(op, left(frame, ctx), right(frame, ctx), span);
      const v = assertValue(r, span);
      if (typeof v === 'string') checkStringLength(v.length, ctx.limits, span);
      return v;
    };
  }

  private compileCoalesce(leftExpr: Expr, rightExpr: Expr, scope: CompileScope): Eval {
    const left = this.compile(leftExpr, scope);
    const right = this.compileHandled(rightExpr, scope);
    return (frame, ctx) => {
      const l = left(frame, ctx);
      if (l instanceof Failure || l === null) return right(frame, ctx);
      return l;
    };
  }

  private compileLogical(expr: BinaryExpr, scope: CompileScope): Eval {
    const left = this.compileHandled(expr.left, scope);
    const right = this.compileHandled(expr.right, scope);
    const span = expr.span;
    if (expr.op === '&&') {
      return (frame, ctx) => {
        if (!asBool(left(frame, ctx), span)) return false;
        return asBool(right(frame, ctx), span);
      };
    }
    return (frame, ctx) => {
      if (asBool(left(frame, ctx), span)) return true;
      return asBool(right(frame, ctx), span);
    };
  }

  private compileIs(subjectExpr: Expr, typeName: string, scope: CompileScope): Eval {
    const subject = this.compileHandled(subjectExpr, scope);
    return (frame, ctx) => matchesKindName(typeName, subject(frame, ctx));
  }

  private compileAssert(operandExpr: Expr, span: Span, scope: CompileScope): Eval {
    const operand = this.compile(operandExpr, scope);
    return (frame, ctx) => {
      const v = operand(frame, ctx);
      if (v instanceof Failure) throw abortSignal(v.message, span);
      return v;
    };
  }

  private compileIndex(
    targetExpr: Expr,
    indexExpr: Expr,
    span: Span,
    scope: CompileScope,
  ): EvalFallible {
    const target = this.compileHandled(targetExpr, scope);
    const index = this.compileHandled(indexExpr, scope);
    return (frame, ctx) => {
      const t = target(frame, ctx);
      const i = index(frame, ctx);
      if (Array.isArray(t)) {
        if (typeof i !== 'bigint') return new Failure('array index must be an integer');
        const n = Number(i);
        const idx = n < 0 ? t.length + n : n;
        if (idx < 0 || idx >= t.length) return new Failure(`array index ${n} out of range`);
        return t[idx]!;
      }
      if (t instanceof Map) {
        if (typeof i !== 'string') return new Failure('object index must be a string');
        if (!t.has(i)) return new Failure(`object has no field ${JSON.stringify(i)}`);
        return t.get(i)!;
      }
      return new Failure(`${describeRuntimeKind(t)} cannot be indexed with []`);
    };
  }

  private compileField(targetExpr: Expr, name: string, span: Span, scope: CompileScope): Eval {
    const target = this.compileHandled(targetExpr, scope);
    return (frame, ctx) => {
      const t = target(frame, ctx);
      if (!(t instanceof Map)) {
        throw abortSignal(`cannot access field '${name}' of ${describeRuntimeKind(t)}`, span);
      }
      return t.get(name) ?? null;
    };
  }

  // ---- control flow ---------------------------------------------------------------------------

  private compileIf(expr: IfExpr, scope: CompileScope): EvalFallible {
    const condition = this.compileHandled(expr.condition, scope);
    const span = expr.condition.span;
    const thenEval = this.compileBlock(expr.thenBranch, scope.child());
    let elseEval: EvalFallible;
    if (expr.elseBranch === undefined) {
      elseEval = () => null;
    } else if (expr.elseBranch.kind === 'if') {
      elseEval = this.compileIf(expr.elseBranch, scope);
    } else {
      elseEval = this.compileBlock(expr.elseBranch, scope.child());
    }
    return (frame, ctx) =>
      asBool(condition(frame, ctx), span) ? thenEval(frame, ctx) : elseEval(frame, ctx);
  }

  private compileBlock(block: BlockExpr, scope: CompileScope): EvalFallible {
    const execs = this.compileStatements(block.statements, scope);
    const resultEval = block.result !== undefined ? this.compile(block.result, scope) : undefined;
    return (frame, ctx) => {
      for (const exec of execs) exec(frame, ctx);
      return resultEval === undefined ? null : resultEval(frame, ctx);
    };
  }

  private compileAbort(reasonExpr: Expr | undefined, span: Span, scope: CompileScope): Eval {
    if (reasonExpr === undefined) {
      return () => {
        throw abortSignal('abort', span);
      };
    }
    const reason = this.compileHandled(reasonExpr, scope);
    return (frame, ctx) => {
      const r = reason(frame, ctx);
      throw abortSignal(typeof r === 'string' ? r : 'abort', span);
    };
  }

  private compileMatch(expr: MatchExpr, scope: CompileScope): EvalFallible {
    const subject = this.compileHandled(expr.subject, scope);
    const arms = expr.arms.map((arm) => {
      const armScope = scope.child();
      const matcher = this.compileMatchPattern(arm.pattern, armScope);
      const body = this.compile(arm.body, armScope);
      return { matcher, body };
    });
    const span = expr.span;
    return (frame, ctx) => {
      const s = subject(frame, ctx);
      for (const arm of arms) {
        if (arm.matcher(s, frame)) return arm.body(frame, ctx);
      }
      throw new ScriptBugError('internal error: no match arm matched an exhaustive match', span);
    };
  }

  private compileMatchPattern(
    pattern: Pattern,
    armScope: CompileScope,
  ): (value: RuntimeValue, frame: Frame) => boolean {
    switch (pattern.kind) {
      case 'wildcardPattern':
        return () => true;
      case 'literalPattern': {
        const lit = literalPatternValue(pattern.value);
        return (value) => runtimeEquals(value, lit);
      }
      case 'kindPattern': {
        const typeName = pattern.typeName;
        return (value) => matchesKindName(typeName, value);
      }
      case 'regexPattern': {
        const re = new RegExp(pattern.pattern, pattern.flags);
        return (value) => typeof value === 'string' && re.test(value);
      }
      case 'objectPattern': {
        const fields = pattern.fields.map((f) => ({
          key: f.key,
          slot: armScope.declare(f.binding),
        }));
        const rest = pattern.rest;
        return (value, frame) => {
          if (!(value instanceof Map)) return false;
          if (!rest && value.size !== fields.length) return false;
          for (const f of fields) {
            if (!value.has(f.key)) return false;
          }
          for (const f of fields) frame[f.slot] = value.get(f.key)!;
          return true;
        };
      }
    }
  }

  // ---- calls --------------------------------------------------------------------------------

  private compileCall(expr: CallExpr, scope: CompileScope): EvalFallible {
    const resolved = this.calls.get(expr);
    if (resolved === undefined) {
      throw new ScriptBugError('internal error: call was not resolved by the checker', expr.span);
    }
    const signature = resolved.signature;

    if (signature.name === 'del' || signature.name === 'exists') {
      return this.compilePathIntrinsic(expr, signature.name);
    }

    const implementation = this.implementations.get(signature.name);
    if (implementation === undefined) {
      throw new Error(
        `internal error: no runtime implementation registered for '${signature.name}'`,
      );
    }

    const slots = new Map<FunctionParam, Argument | undefined>(
      signature.params.map((p) => [p, undefined]),
    );
    const positionalEligible = signature.params.filter((p) => !p.namedOnly);
    let positionalIndex = 0;
    for (const arg of expr.args) {
      if (arg.kind === 'positional') {
        const target = positionalEligible[positionalIndex];
        positionalIndex++;
        if (target !== undefined) slots.set(target, arg);
      } else {
        const target = signature.params.find((p) => p.name === arg.name);
        if (target !== undefined) slots.set(target, arg);
      }
    }

    const positionalCompiled: EvalFallible[] = [];
    const positionalSupplied: boolean[] = [];
    const namedCompiled: Array<[string, EvalFallible]> = [];
    const closureFactories: Array<(outerFrame: Frame) => CompiledClosure> = [];

    for (const p of signature.params) {
      const arg = slots.get(p);
      if (p.closure !== undefined) {
        if (arg === undefined) {
          throw new ScriptBugError(
            `internal error: required closure argument '${p.name}' was not supplied`,
            expr.span,
          );
        }
        closureFactories.push(this.compileClosureArg(arg.value, p.closure, scope));
        continue;
      }
      if (p.namedOnly) {
        if (arg !== undefined) namedCompiled.push([p.name, this.compile(arg.value, scope)]);
        continue;
      }
      if (arg === undefined) {
        positionalCompiled.push(() => null);
        positionalSupplied.push(false);
      } else {
        positionalCompiled.push(this.compile(arg.value, scope));
        positionalSupplied.push(true);
      }
    }

    const span = expr.span;
    return (frame, ctx) => {
      ctx.currentSpan = span;
      const positional: RuntimeValue[] = new Array<RuntimeValue>(positionalCompiled.length);
      for (let i = 0; i < positionalCompiled.length; i++) {
        if (!positionalSupplied[i]) {
          positional[i] = null;
          continue;
        }
        const v = positionalCompiled[i]!(frame, ctx);
        if (v instanceof Failure) return v;
        positional[i] = v;
      }
      const named = new Map<string, RuntimeValue>();
      for (const [name, c] of namedCompiled) {
        const v = c(frame, ctx);
        if (v instanceof Failure) return v;
        named.set(name, v);
      }
      const closures = closureFactories.map((f) => f(frame));
      return implementation.call({ positional, named, closures, positionalSupplied }, ctx, span);
    };
  }

  private compilePathIntrinsic(expr: CallExpr, name: 'del' | 'exists'): Eval {
    const firstArg = expr.args[0];
    const argExpr = firstArg?.value;
    if (argExpr === undefined || argExpr.kind !== 'path') {
      throw new ScriptBugError(`internal error: '${name}' requires a path argument`, expr.span);
    }
    const segments = argExpr.segments;
    if (name === 'del') {
      return (_frame, ctx) => deletePath(ctx.event.fields, segments) ?? null;
    }
    return (_frame, ctx) => hasPath(ctx.event.fields, segments);
  }

  private compileClosureArg(
    argExpr: Expr,
    closureSig: ClosureSignature,
    scope: CompileScope,
  ): (outerFrame: Frame) => CompiledClosure {
    if (argExpr.kind !== 'closure') {
      throw new ScriptBugError('internal error: expected a closure argument', argExpr.span);
    }
    const closureScope = scope.child();
    const paramSlots = argExpr.params.map((p) => closureScope.declare(p.name));
    const body = this.compileHandled(argExpr.body, closureScope);
    return (outerFrame: Frame) => (args, ctx) => {
      for (let i = 0; i < paramSlots.length; i++) outerFrame[paramSlots[i]!] = args[i] ?? null;
      return body(outerFrame, ctx);
    };
  }
}

// ---- free functions ---------------------------------------------------------------------------

function asBool(value: RuntimeValue, span: Span): boolean {
  if (typeof value === 'boolean') return value;
  throw abortSignal(`expected \`bool\`, found ${describeRuntimeKind(value)}`, span);
}

function describeRuntimeKind(value: RuntimeValue): string {
  if (isRegexValue(value)) return 'a regex';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'an int';
  if (typeof value === 'number') return 'a float';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'boolean') return 'a bool';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Map) return 'an object';
  if (value instanceof Timestamp) return 'a timestamp';
  return 'bytes';
}

function bigintRelational(op: string): (a: bigint, b: bigint) => boolean {
  switch (op) {
    case '<':
      return (a, b) => a < b;
    case '<=':
      return (a, b) => a <= b;
    case '>':
      return (a, b) => a > b;
    default:
      return (a, b) => a >= b;
  }
}

function numberRelational(op: string): (a: number, b: number) => boolean {
  switch (op) {
    case '<':
      return (a, b) => a < b;
    case '<=':
      return (a, b) => a <= b;
    case '>':
      return (a, b) => a > b;
    default:
      return (a, b) => a >= b;
  }
}

function stringRelational(op: string): (a: string, b: string) => boolean {
  switch (op) {
    case '<':
      return (a, b) => a < b;
    case '<=':
      return (a, b) => a <= b;
    case '>':
      return (a, b) => a > b;
    default:
      return (a, b) => a >= b;
  }
}

function literalPatternValue(node: {
  kind: string;
  value?: unknown;
  parts?: readonly { kind: string; value?: string }[];
  span: Span;
}): RuntimeValue {
  switch (node.kind) {
    case 'int':
      return wrapInt64(node.value as bigint);
    case 'float':
      return node.value as number;
    case 'bool':
      return node.value as boolean;
    case 'null':
      return null;
    case 'string': {
      const parts = node.parts ?? [];
      if (parts.length === 0) return '';
      if (parts.length === 1 && parts[0]!.kind === 'text') return parts[0]!.value as string;
      throw new ScriptBugError(
        'internal error: interpolated strings are not supported in match patterns',
        node.span,
      );
    }
    default:
      throw new ScriptBugError(
        `internal error: unsupported literal pattern kind '${node.kind}'`,
        node.span,
      );
  }
}

function toPathSegmentRuntime(value: RuntimeValue, span: Span): PathSegment {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  throw abortSignal(`index must be an int or string, found ${describeRuntimeKind(value)}`, span);
}
