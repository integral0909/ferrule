import { makeDiagnostic, type Diagnostic, type Fix } from '../diagnostics/diagnostic.js';
import { createDefaultRegistry } from '../registry/builtins.js';
import {
  resolveReturnType,
  type FunctionParam,
  type FunctionRegistry,
  type FunctionSignature,
} from '../registry/signature.js';
import type {
  AbortExpr,
  Argument,
  AssertExpr,
  AssignStatement,
  BinaryExpr,
  BlockExpr,
  BoolLiteral,
  CallExpr,
  ClosureExpr,
  Expr,
  FieldAccessExpr,
  FloatLiteral,
  IfExpr,
  IndexExpr,
  IntLiteral,
  IsExpr,
  LetCaptureStatement,
  LetStatement,
  MatchExpr,
  NullLiteral,
  ObjectLiteral,
  ObjectPattern,
  PathExpr,
  Pattern,
  Program,
  Statement,
  StringLiteral,
  TestDecl,
  UnaryExpr,
} from '../syntax/ast.js';
import type { Span } from '../syntax/source.js';
import {
  anyType,
  arrayType,
  boolType,
  bytesType,
  type ExprType,
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
  type Type,
  typeFromKindName,
  typesEqual,
  unionType,
} from '../types/types.js';
import { didYouMean } from './editDistance.js';
import { Scope, type Binding } from './scope.js';
import type { CheckOptions, CheckResult, ResolvedCall } from './typedProgram.js';

/** Type-checks and resolves a parsed program. Never throws. See {@link CheckResult}. */
export function check(program: Program, options: CheckOptions = {}): CheckResult {
  const checker = new Checker(
    options.registry ?? createDefaultRegistry(),
    options.inputSchema ?? anyType,
    options.validateWrites ?? false,
    options.readonlyPaths ?? EMPTY_READONLY_PATHS,
  );
  checker.run(program);
  const types = checker.types;
  return {
    program,
    diagnostics: checker.diagnostics,
    types,
    calls: checker.calls,
    typeOf: (expr: Expr) => types.get(expr) ?? handled(anyType),
  };
}

interface Narrowing {
  readonly key: string;
  readonly type: Type;
}

const EMPTY_READONLY_PATHS: ReadonlyMap<string, string> = new Map();

class Checker {
  readonly diagnostics: Diagnostic[] = [];
  readonly types = new Map<Expr, ExprType>();
  readonly calls = new Map<CallExpr, ResolvedCall>();
  /** Active flow-narrowed types, keyed by `id:<name>` or `path:<segments json>`. */
  private readonly narrow = new Map<string, Type>();
  private reportedUnreachable = false;

  constructor(
    private readonly registry: FunctionRegistry,
    private readonly inputSchema: Type,
    private readonly validateWrites: boolean = false,
    private readonly readonlyPaths: ReadonlyMap<string, string> = EMPTY_READONLY_PATHS,
  ) {}

  run(program: Program): void {
    const root = new Scope();
    this.checkStatements(program.statements, root);
    this.checkUnusedInScope(root);
  }

  // ---- diagnostics helpers ------------------------------------------------------------------

  private error(
    code: string,
    message: string,
    span: Span,
    fixes: readonly Fix[] = [],
    notes: readonly string[] = [],
  ): void {
    this.diagnostics.push(makeDiagnostic({ code, message, span, fixes, notes }));
  }

  private warn(code: string, message: string, span: Span): void {
    this.diagnostics.push(makeDiagnostic({ code, severity: 'warning', message, span }));
  }

  private setType(expr: Expr, type: ExprType): ExprType {
    this.types.set(expr, type);
    return type;
  }

  /** Enforces design.md §5: a `T!` expression must be handled before it is used. */
  private requireHandled(exprType: ExprType, span: Span): ExprType {
    if (!exprType.fallible) return exprType;
    const suffixSpan: Span = { start: span.end, end: span.end };
    const fixes: Fix[] = [
      {
        description: 'use `??` to provide a fallback value',
        edits: [{ span: suffixSpan, newText: ' ?? <fallback>' }],
      },
      {
        description: 'use `!` to abort the event if this fails',
        edits: [{ span: suffixSpan, newText: '!' }],
      },
    ];
    this.error(
      'E401',
      `unhandled fallible expression of type \`${formatExprType(exprType)}\`: handle it with \`??\`, \`!\`, or error capture (\`let v, err = ...\`)`,
      span,
      fixes,
      [
        'error capture rewrites `let x = expr` into `let x, err = expr`, binding the failure reason to `err`',
      ],
    );
    return handled(exprType.type);
  }

  // ---- statements -----------------------------------------------------------------------------

  /** Returns true if control cannot fall through past this statement list (a diverging tail). */
  private checkStatements(statements: readonly Statement[], scope: Scope): boolean {
    let diverged = false;
    for (const stmt of statements) {
      if (diverged && !this.reportedUnreachable) {
        this.warn('W504', 'unreachable code', stmt.span);
        this.reportedUnreachable = true;
      }
      const stmtDiverges = this.checkStatement(stmt, scope);
      diverged = diverged || stmtDiverges;
    }
    return diverged;
  }

  private checkStatement(stmt: Statement, scope: Scope): boolean {
    switch (stmt.kind) {
      case 'exprStatement': {
        const t = this.checkExpr(stmt.expr, scope);
        this.requireHandled(t, stmt.expr.span);
        return t.type.kind === 'never';
      }
      case 'let':
        this.checkLet(stmt, scope);
        return false;
      case 'letCapture':
        this.checkLetCapture(stmt, scope);
        return false;
      case 'assign':
        this.checkAssign(stmt, scope);
        return false;
      case 'test':
        this.checkTest(stmt, scope);
        return false;
    }
  }

  private declareOrRedeclare(scope: Scope, binding: Binding): void {
    if (scope.declaredHere(binding.name)) {
      this.error('E203', `'${binding.name}' is already declared in this scope`, binding.span);
    }
    scope.declare(binding);
  }

  private checkLet(stmt: LetStatement, scope: Scope): void {
    const valueType = this.checkExpr(stmt.value, scope);
    const handledType = this.requireHandled(valueType, stmt.value.span);
    this.declareOrRedeclare(scope, {
      name: stmt.name,
      type: handledType.type,
      mutable: stmt.mutable,
      span: stmt.nameSpan,
      used: false,
    });
  }

  private checkLetCapture(stmt: LetCaptureStatement, scope: Scope): void {
    const valueType = this.checkExpr(stmt.value, scope);
    this.declareOrRedeclare(scope, {
      name: stmt.valueName,
      type: valueType.type,
      mutable: false,
      span: stmt.valueNameSpan,
      used: false,
    });
    this.declareOrRedeclare(scope, {
      name: stmt.errName,
      type: unionType([stringType, nullType]),
      mutable: false,
      span: stmt.errNameSpan,
      used: false,
      isErrorCapture: true,
    });
  }

  private checkAssign(stmt: AssignStatement, scope: Scope): void {
    const valueType = this.checkExpr(stmt.value, scope);
    const handledType = this.requireHandled(valueType, stmt.value.span);
    this.checkAssignTarget(stmt.target, scope, handledType.type);
  }

  private checkAssignTarget(target: Expr, scope: Scope, valueType: Type): void {
    switch (target.kind) {
      case 'path':
        // Default: paths are `any`-typed and always writable (design.md §3's known limitation
        // that writes aren't checked against `inputSchema`). A caller that opted into
        // `validateWrites` (the metric view) gets real validation instead.
        if (this.validateWrites) this.checkPathAssignTarget(target, valueType);
        return;
      case 'identifier': {
        const binding = scope.lookup(target.name);
        if (binding === undefined) {
          this.reportUndefinedVariable(target.name, target.span, scope);
          return;
        }
        if (!binding.mutable) {
          this.error(
            'E204',
            `cannot assign to '${target.name}': declared with \`let\`, not \`let mut\``,
            target.span,
            [{ description: 'declare it as `let mut` instead', edits: [] }],
          );
          return;
        }
        if (!isSubtype(valueType, binding.type)) {
          this.error(
            'E301',
            `cannot assign a value of type \`${formatType(valueType)}\` to '${target.name}' of type \`${formatType(binding.type)}\``,
            target.span,
          );
        }
        return;
      }
      case 'field':
        this.checkAssignTarget(target.target, scope, anyType);
        return;
      case 'index':
        this.checkAssignTarget(target.target, scope, anyType);
        this.requireHandled(this.checkExpr(target.index, scope), target.index.span);
        return;
      default:
        return; // parser already reported E108 for anything else
    }
  }

  /**
   * Validates a path write against `inputSchema` when `validateWrites` is set (see
   * {@link CheckOptions.validateWrites}): a top-level field in `readonlyPaths` is never
   * assignable — through *any* path that starts with it, not just a bare one-segment
   * reassignment, since a read-only field can still be a structured value (an array/object) with
   * writable-looking sub-paths of its own (the span view's `.annotations`/`.links` are read-only
   * arrays of objects; `.annotations[0].name = x` must be rejected exactly like
   * `.annotations = []` is) — and otherwise the assigned value must be a subtype of the path's
   * schema-declared type (an open `rest`/`any` along the way stays permissive, same as a read).
   */
  private checkPathAssignTarget(target: PathExpr, valueType: Type): void {
    const first = target.segments[0];
    if (typeof first === 'string') {
      const message = this.readonlyPaths.get(first);
      if (message !== undefined) {
        this.error('E311', message, target.span);
        return;
      }
    }
    const resolved = resolveWritePathType(this.inputSchema, target.segments);
    if (resolved.error !== undefined) {
      this.error('E302', resolved.error, target.span);
      return;
    }
    if (resolved.type.kind !== 'any' && !isSubtype(valueType, resolved.type)) {
      this.error(
        'E301',
        `cannot assign a value of type \`${formatType(valueType)}\` to a field of type \`${formatType(resolved.type)}\``,
        target.span,
      );
    }
  }

  private checkTest(stmt: TestDecl, scope: Scope): void {
    const testScope = scope.child();
    this.checkExpr(stmt.given, testScope);
    this.checkExpr(stmt.expect, testScope);
    this.checkAgainstInputSchema(stmt.given, 'given');
    this.checkAgainstInputSchema(stmt.expect, 'expect');
  }

  /**
   * `given`/`expect` describe event field values as plain object literals, so once an
   * `inputSchema` is declared, a field the schema types can be checked directly against the
   * literal the test wrote — this catches a test fixture drifting out of sync with the schema
   * without waiting for the (later-milestone) test runner. Fields the schema does not mention are
   * left alone: a `given`/`expect` block is allowed to be partial.
   */
  private checkAgainstInputSchema(obj: ObjectLiteral, label: 'given' | 'expect'): void {
    if (this.inputSchema.kind !== 'object') return;
    for (const prop of obj.properties) {
      const declared = this.inputSchema.fields.get(prop.key);
      if (declared === undefined) continue;
      const actual = this.types.get(prop.value);
      if (actual === undefined || isSubtype(actual.type, declared)) continue;
      this.error(
        'E301',
        `\`${label}\` field '${prop.key}' has type \`${formatType(actual.type)}\`, but the input schema declares \`${formatType(declared)}\``,
        prop.value.span,
      );
    }
  }

  // ---- expressions ------------------------------------------------------------------------------

  private checkExpr(expr: Expr, scope: Scope): ExprType {
    const result = this.checkExprInner(expr, scope);
    return this.setType(expr, result);
  }

  private checkExprInner(expr: Expr, scope: Scope): ExprType {
    switch (expr.kind) {
      case 'int':
        return handled(intType);
      case 'float':
        return handled(floatType);
      case 'bool':
        return handled(boolType);
      case 'null':
        return handled(nullType);
      case 'rawString':
        return handled(stringType);
      case 'byteString':
        return handled(bytesType);
      case 'timestamp':
        return handled(timestampType);
      case 'regex':
        return handled(regexType);
      case 'string':
        return this.checkStringLiteral(expr, scope);
      case 'path':
        return handled(
          this.narrowedOrElse(pathKey(expr.segments), () =>
            pathType(this.inputSchema, expr.segments),
          ),
        );
      case 'metadataPath':
        return handled(anyType);
      case 'identifier':
        return this.checkIdentifier(expr.name, expr.span, scope);
      case 'array':
        return this.checkArrayLiteral(expr.elements, scope);
      case 'object':
        return this.checkObjectLiteral(expr, scope);
      case 'unary':
        return this.checkUnary(expr, scope);
      case 'binary':
        return this.checkBinary(expr, scope);
      case 'is':
        return this.checkIs(expr, scope);
      case 'assert':
        return this.checkAssert(expr, scope);
      case 'index':
        return this.checkIndex(expr, scope);
      case 'field':
        return this.checkField(expr, scope);
      case 'call':
        return this.checkCall(expr, scope);
      case 'closure':
        return this.checkStrayClosure(expr, scope);
      case 'if':
        return this.checkIf(expr, scope);
      case 'match':
        return this.checkMatch(expr, scope);
      case 'block':
        return this.checkBlock(expr, scope.child());
      case 'drop':
        return handled(neverType);
      case 'abort':
        return this.checkAbort(expr, scope);
      case 'error':
        return handled(anyType);
    }
  }

  private narrowedOrElse(key: string, fallback: () => Type): Type {
    return this.narrow.get(key) ?? fallback();
  }

  private checkStringLiteral(expr: StringLiteral, scope: Scope): ExprType {
    for (const part of expr.parts) {
      if (part.kind === 'interpolation') {
        const t = this.checkExpr(part.expr, scope);
        this.requireHandled(t, part.expr.span);
      }
    }
    return handled(stringType);
  }

  private checkIdentifier(name: string, span: Span, scope: Scope): ExprType {
    const binding = scope.lookup(name);
    if (binding === undefined) {
      this.reportUndefinedVariable(name, span, scope);
      return handled(anyType);
    }
    binding.used = true;
    return handled(this.narrowedOrElse(`id:${name}`, () => binding.type));
  }

  private reportUndefinedVariable(name: string, span: Span, scope: Scope): void {
    const suggestion = didYouMean(name, scope.visibleNames());
    const note = suggestion === undefined ? [] : [`did you mean '${suggestion}'?`];
    this.error('E201', `undefined variable '${name}'`, span, [], note);
  }

  private checkArrayLiteral(elements: readonly Expr[], scope: Scope): ExprType {
    let elementType: Type = neverType;
    for (const el of elements) {
      const t = this.requireHandled(this.checkExpr(el, scope), el.span);
      elementType = joinTypes(elementType, t.type);
    }
    return handled(arrayType(elementType));
  }

  private checkObjectLiteral(expr: ObjectLiteral, scope: Scope): ExprType {
    const fields = new Map<string, Type>();
    for (const prop of expr.properties) {
      const t = this.requireHandled(this.checkExpr(prop.value, scope), prop.value.span);
      fields.set(prop.key, t.type);
    }
    return handled(objectType(fields));
  }

  private checkUnary(expr: UnaryExpr, scope: Scope): ExprType {
    const operand = this.requireHandled(this.checkExpr(expr.operand, scope), expr.operand.span);
    if (expr.op === '-') {
      if (typesEqual(operand.type, intType) || typesEqual(operand.type, floatType)) {
        return handled(operand.type);
      }
      if (operand.type.kind === 'any') return handled(anyType);
      this.error(
        'E301',
        `unary '-' requires \`int\` or \`float\`, found \`${formatType(operand.type)}\``,
        expr.span,
      );
      return handled(anyType);
    }
    // '!'
    if (typesEqual(operand.type, boolType) || operand.type.kind === 'any') return handled(boolType);
    this.error('E306', `'!' requires \`bool\`, found \`${formatType(operand.type)}\``, expr.span);
    return handled(boolType);
  }

  private static readonly NUMERIC_ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
  private static readonly RELATIONAL = new Set(['<', '<=', '>', '>=']);

  private checkBinary(expr: BinaryExpr, scope: Scope): ExprType {
    if (expr.op === '??') return this.checkCoalesce(expr, scope);
    if (expr.op === '&&' || expr.op === '||') return this.checkLogical(expr, scope);

    const left = this.requireHandled(this.checkExpr(expr.left, scope), expr.left.span);
    const right = this.requireHandled(this.checkExpr(expr.right, scope), expr.right.span);

    if (expr.op === '==' || expr.op === '!=') {
      if (!comparable(left.type, right.type)) {
        this.error(
          'E301',
          `cannot compare \`${formatType(left.type)}\` with \`${formatType(right.type)}\``,
          expr.span,
        );
      }
      return handled(boolType);
    }

    if (Checker.RELATIONAL.has(expr.op)) {
      const ok =
        (typesEqual(left.type, intType) && typesEqual(right.type, intType)) ||
        (typesEqual(left.type, floatType) && typesEqual(right.type, floatType)) ||
        (typesEqual(left.type, stringType) && typesEqual(right.type, stringType)) ||
        left.type.kind === 'any' ||
        right.type.kind === 'any';
      if (!ok) {
        this.error(
          'E301',
          `'${expr.op}' requires two \`int\`, two \`float\`, or two \`string\` operands, found \`${formatType(left.type)}\` and \`${formatType(right.type)}\``,
          expr.span,
        );
      }
      return handled(boolType);
    }

    // Arithmetic: + - * / %
    if (
      expr.op === '+' &&
      typesEqual(left.type, stringType) &&
      typesEqual(right.type, stringType)
    ) {
      return handled(stringType);
    }
    if (left.type.kind === 'any' || right.type.kind === 'any') {
      return this.arithmeticResult(expr.op, anyType);
    }
    const bothInt = typesEqual(left.type, intType) && typesEqual(right.type, intType);
    const bothFloat = typesEqual(left.type, floatType) && typesEqual(right.type, floatType);
    if (!bothInt && !bothFloat) {
      const bothNumeric =
        (left.type.kind === 'int' || left.type.kind === 'float') &&
        (right.type.kind === 'int' || right.type.kind === 'float');
      const code = bothNumeric ? 'E305' : 'E301';
      const message = bothNumeric
        ? `\`int\` and \`float\` are never implicitly mixed; convert one side with \`to_int\`/\`to_float\``
        : `'${expr.op}' requires two \`int\` or two \`float\` operands, found \`${formatType(left.type)}\` and \`${formatType(right.type)}\``;
      this.error(code, message, expr.span);
      return handled(anyType);
    }
    return this.arithmeticResult(expr.op, bothInt ? intType : floatType);
  }

  private arithmeticResult(op: string, numericType: Type): ExprType {
    if (
      (op === '/' || op === '%') &&
      (typesEqual(numericType, intType) || numericType.kind === 'any')
    ) {
      return fallibleOf(numericType);
    }
    return handled(numericType);
  }

  private checkCoalesce(expr: BinaryExpr, scope: Scope): ExprType {
    const left = this.checkExpr(expr.left, scope);
    const right = this.requireHandled(this.checkExpr(expr.right, scope), expr.right.span);
    if (!left.fallible && !typeIncludesNull(left.type)) {
      this.warn(
        'W501',
        'the fallback of `??` is never used: the left side cannot fail or be `null`',
        expr.span,
      );
    }
    return handled(joinTypes(nonNullOf(left.type), right.type));
  }

  private checkLogical(expr: BinaryExpr, scope: Scope): ExprType {
    const left = this.requireHandled(this.checkExpr(expr.left, scope), expr.left.span);
    if (!typesEqual(left.type, boolType) && left.type.kind !== 'any') {
      this.error(
        'E306',
        `'${expr.op}' requires \`bool\` operands, found \`${formatType(left.type)}\``,
        expr.left.span,
      );
    }
    const narrowings = expr.op === '&&' ? this.narrowingsFromTypedCondition(expr.left) : [];
    const right = this.withNarrowings(narrowings, 'meet', () =>
      this.requireHandled(this.checkExpr(expr.right, scope), expr.right.span),
    );
    if (!typesEqual(right.type, boolType) && right.type.kind !== 'any') {
      this.error(
        'E306',
        `'${expr.op}' requires \`bool\` operands, found \`${formatType(right.type)}\``,
        expr.right.span,
      );
    }
    return handled(boolType);
  }

  private checkIs(expr: IsExpr, scope: Scope): ExprType {
    this.requireHandled(this.checkExpr(expr.subject, scope), expr.subject.span);
    if (typeFromKindName(expr.typeName) === undefined) {
      this.error('E301', `'${expr.typeName}' is not a known type name`, expr.typeNameSpan);
    }
    return handled(boolType);
  }

  private checkAssert(expr: AssertExpr, scope: Scope): ExprType {
    const operand = this.checkExpr(expr.operand, scope);
    if (!operand.fallible) {
      this.warn('W505', 'redundant `!`: this expression cannot fail', expr.span);
    }
    return handled(operand.type);
  }

  private checkIndex(expr: IndexExpr, scope: Scope): ExprType {
    const target = this.requireHandled(this.checkExpr(expr.target, scope), expr.target.span);
    const index = this.requireHandled(this.checkExpr(expr.index, scope), expr.index.span);
    if (target.type.kind === 'any') return fallibleOf(anyType);
    if (target.type.kind === 'array') {
      if (!typesEqual(index.type, intType) && index.type.kind !== 'any') {
        this.error(
          'E301',
          `array index must be \`int\`, found \`${formatType(index.type)}\``,
          expr.index.span,
        );
      }
      return fallibleOf(target.type.element);
    }
    if (target.type.kind === 'object') {
      if (!typesEqual(index.type, stringType) && index.type.kind !== 'any') {
        this.error(
          'E301',
          `object index must be \`string\`, found \`${formatType(index.type)}\``,
          expr.index.span,
        );
      }
      return fallibleOf(target.type.rest ?? anyType);
    }
    this.error(
      'E307',
      `type \`${formatType(target.type)}\` cannot be indexed with \`[]\``,
      expr.span,
    );
    return handled(anyType);
  }

  private checkField(expr: FieldAccessExpr, scope: Scope): ExprType {
    const target = this.requireHandled(this.checkExpr(expr.target, scope), expr.target.span);
    if (target.type.kind === 'any') return handled(anyType);
    if (target.type.kind === 'object') {
      const field = target.type.fields.get(expr.name);
      if (field !== undefined) return handled(field);
      if (target.type.rest !== undefined) return handled(target.type.rest);
      const suggestion = didYouMean(expr.name, [...target.type.fields.keys()]);
      const note = suggestion === undefined ? [] : [`did you mean '.${suggestion}'?`];
      this.error(
        'E302',
        `type \`${formatType(target.type)}\` has no field '${expr.name}'`,
        expr.nameSpan,
        [],
        note,
      );
      return handled(anyType);
    }
    this.error('E302', `type \`${formatType(target.type)}\` has no fields`, expr.nameSpan);
    return handled(anyType);
  }

  // ---- calls --------------------------------------------------------------------------------

  private checkCall(expr: CallExpr, scope: Scope): ExprType {
    if (expr.callee.kind !== 'identifier') {
      this.error('E308', 'only a plain function name can be called', expr.callee.span);
      for (const arg of expr.args) {
        this.requireHandled(this.checkExpr(arg.value, scope), arg.value.span);
      }
      return handled(anyType);
    }
    const name = expr.callee.name;
    const signature = this.registry.get(name);
    if (signature === undefined) {
      const suggestion = didYouMean(name, this.registry.names());
      const note = suggestion === undefined ? [] : [`did you mean '${suggestion}()'?`];
      this.error('E202', `undefined function '${name}'`, expr.callee.span, [], note);
      for (const arg of expr.args) {
        this.requireHandled(this.checkExpr(arg.value, scope), arg.value.span);
      }
      return handled(anyType);
    }
    return this.checkResolvedCall(expr, signature, scope);
  }

  private checkResolvedCall(expr: CallExpr, signature: FunctionSignature, scope: Scope): ExprType {
    const slots = new Map<FunctionParam, Argument | undefined>(
      signature.params.map((p) => [p, undefined]),
    );
    const positionalEligible = signature.params.filter((p) => !p.namedOnly);
    let positionalIndex = 0;

    for (const arg of expr.args) {
      if (arg.kind === 'positional') {
        const target = positionalEligible[positionalIndex];
        positionalIndex++;
        if (target === undefined) {
          this.error('E303', `too many arguments to '${signature.name}'`, arg.span);
          this.requireHandled(this.checkExpr(arg.value, scope), arg.value.span);
          continue;
        }
        slots.set(target, arg);
      } else {
        const target = signature.params.find((p) => p.name === arg.name);
        if (target === undefined) {
          const suggestion = didYouMean(
            arg.name,
            signature.params.map((p) => p.name),
          );
          const note = suggestion === undefined ? [] : [`did you mean '${suggestion}:'?`];
          this.error(
            'E304',
            `'${signature.name}' has no parameter named '${arg.name}'`,
            arg.nameSpan,
            [],
            note,
          );
          this.requireHandled(this.checkExpr(arg.value, scope), arg.value.span);
          continue;
        }
        if (slots.get(target) !== undefined) {
          this.error('E106', `argument '${arg.name}' was already provided`, arg.nameSpan);
        }
        slots.set(target, arg);
      }
    }

    let anyMismatch = false;
    let closureReturn: ExprType | undefined;
    const positionalArgTypes: ExprType[] = [];
    const argExprs: (Expr | undefined)[] = [];

    for (const p of signature.params) {
      const arg = slots.get(p);
      argExprs.push(arg?.value);
      if (arg === undefined) {
        if (!p.optional) {
          this.error(
            'E303',
            `missing required argument '${p.name}' to '${signature.name}'`,
            expr.span,
          );
        }
        positionalArgTypes.push(handled(p.type));
        continue;
      }
      if (p.requiresPathArgument && arg.value.kind !== 'path') {
        this.error('E301', `'${p.name}' must be a path, e.g. \`.field\``, arg.value.span);
      }
      if (p.closure !== undefined) {
        const result = this.checkClosureArgument(arg.value, p.closure, scope);
        closureReturn = result;
        positionalArgTypes.push(result ?? handled(anyType));
        continue;
      }
      const argType = this.requireHandled(this.checkExpr(arg.value, scope), arg.value.span);
      if (!isGuaranteedMatch(argType.type, p.type)) anyMismatch = true;
      positionalArgTypes.push(argType);
    }

    const fallible = signature.fallible === 'always' || anyMismatch;
    const returnType = resolveReturnType(signature, positionalArgTypes, {
      closureReturn,
      argExprs,
    });
    this.calls.set(expr, { signature });
    return { type: returnType, fallible };
  }

  private checkClosureArgument(
    argExpr: Expr,
    closureSig: NonNullable<FunctionParam['closure']>,
    scope: Scope,
  ): ExprType | undefined {
    if (argExpr.kind !== 'closure') {
      this.error(
        'E301',
        `expected a closure with ${closureSig.params.length} parameter(s)`,
        argExpr.span,
      );
      this.requireHandled(this.checkExpr(argExpr, scope), argExpr.span);
      return undefined;
    }
    if (argExpr.params.length !== closureSig.params.length) {
      this.error(
        'E111',
        `closure expects ${closureSig.params.length} parameter(s), found ${argExpr.params.length}`,
        argExpr.span,
      );
    }
    const closureScope = scope.child();
    argExpr.params.forEach((p, i) => {
      closureScope.declare({
        name: p.name,
        type: closureSig.params[i]?.type ?? anyType,
        mutable: false,
        span: p.span,
        used: false,
      });
    });
    const bodyType = this.checkExpr(argExpr.body, closureScope);
    const handledType = this.requireHandled(bodyType, argExpr.body.span);
    this.setType(argExpr, handledType);
    this.checkUnusedInScope(closureScope);
    return handledType;
  }

  private checkStrayClosure(expr: ClosureExpr, scope: Scope): ExprType {
    this.error('E301', 'a closure can only be used as a function argument', expr.span);
    const closureScope = scope.child();
    for (const p of expr.params) {
      closureScope.declare({
        name: p.name,
        type: anyType,
        mutable: false,
        span: p.span,
        used: true,
      });
    }
    this.checkExpr(expr.body, closureScope);
    return handled(anyType);
  }

  // ---- control flow ---------------------------------------------------------------------------

  private checkIf(expr: IfExpr, scope: Scope): ExprType {
    const cond = this.requireHandled(this.checkExpr(expr.condition, scope), expr.condition.span);
    if (!typesEqual(cond.type, boolType) && cond.type.kind !== 'any') {
      this.error(
        'E306',
        `\`if\` condition must be \`bool\`, found \`${formatType(cond.type)}\``,
        expr.condition.span,
      );
    }
    const trueNarrowings = this.narrowingsFromTypedCondition(expr.condition);
    const thenType = this.withNarrowings(trueNarrowings, 'meet', () =>
      this.checkBlock(expr.thenBranch, scope.child()),
    );

    if (expr.elseBranch === undefined) {
      return handled(unionType([thenType.type, nullType]));
    }
    const falseNarrowings = trueNarrowings.length === 1 ? trueNarrowings : [];
    const elseType = this.withNarrowings(falseNarrowings, 'subtract', () =>
      expr.elseBranch!.kind === 'if'
        ? this.checkIf(expr.elseBranch as IfExpr, scope)
        : this.checkBlock(expr.elseBranch as BlockExpr, scope.child()),
    );
    return {
      type: joinTypes(thenType.type, elseType.type),
      fallible: thenType.fallible || elseType.fallible,
    };
  }

  private checkBlock(block: BlockExpr, scope: Scope): ExprType {
    const diverged = this.checkStatements(block.statements, scope);
    this.checkUnusedInScope(scope);
    if (block.result === undefined) {
      return handled(diverged ? neverType : nullType);
    }
    const resultType = this.checkExpr(block.result, scope);
    this.setType(block, resultType);
    return resultType;
  }

  private checkAbort(expr: AbortExpr, scope: Scope): ExprType {
    if (expr.reason !== undefined) {
      const reasonType = this.requireHandled(this.checkExpr(expr.reason, scope), expr.reason.span);
      if (!typesEqual(reasonType.type, stringType) && reasonType.type.kind !== 'any') {
        this.error(
          'E301',
          `abort reason must be \`string\`, found \`${formatType(reasonType.type)}\``,
          expr.reason.span,
        );
      }
    }
    return handled(neverType);
  }

  private checkMatch(expr: MatchExpr, scope: Scope): ExprType {
    const subject = this.requireHandled(this.checkExpr(expr.subject, scope), expr.subject.span);
    const subjectKey = narrowKey(expr.subject);

    let resultType: Type = neverType;
    let fallible = false;
    let hasWildcard = false;
    const coveredKinds: Type[] = [];
    const seenLiterals = new Set<string>();

    for (const arm of expr.arms) {
      const armScope = scope.child();
      this.checkPattern(arm.pattern, subject.type, armScope, subjectKey, seenLiterals);
      if (arm.pattern.kind === 'wildcardPattern') hasWildcard = true;
      if (arm.pattern.kind === 'kindPattern') {
        const t = typeFromKindName(arm.pattern.typeName);
        if (t !== undefined) coveredKinds.push(t);
      }
      const narrowings =
        subjectKey !== undefined && arm.pattern.kind === 'kindPattern'
          ? [{ key: subjectKey, type: typeFromKindName(arm.pattern.typeName) ?? anyType }]
          : [];
      const bodyType = this.withNarrowings(narrowings, 'meet', () =>
        this.checkExpr(arm.body, armScope),
      );
      this.checkUnusedInScope(armScope);
      resultType = joinTypes(resultType, bodyType.type);
      fallible = fallible || bodyType.fallible;
    }

    const coveredType = unionType(coveredKinds.length > 0 ? coveredKinds : [neverType]);
    if (!hasWildcard && !isExhaustive(subject.type, coveredType)) {
      this.error(
        'E309',
        `match is not exhaustive: no arm covers every case of \`${formatType(subject.type)}\`; add a \`_\` arm`,
        expr.span,
      );
    }
    return { type: resultType, fallible };
  }

  private checkPattern(
    pattern: Pattern,
    subjectType: Type,
    armScope: Scope,
    subjectKey: string | undefined,
    seenLiterals: Set<string>,
  ): void {
    switch (pattern.kind) {
      case 'wildcardPattern':
        return;
      case 'literalPattern': {
        const litType = this.checkExpr(pattern.value, armScope).type;
        if (!comparable(litType, subjectType)) {
          this.error(
            'E301',
            `pattern of type \`${formatType(litType)}\` cannot match \`${formatType(subjectType)}\``,
            pattern.span,
          );
        }
        const key = literalKey(pattern.value);
        if (seenLiterals.has(key)) this.error('E310', 'duplicate match arm', pattern.span);
        seenLiterals.add(key);
        return;
      }
      case 'kindPattern':
        return;
      case 'regexPattern':
        if (!typesEqual(subjectType, stringType) && subjectType.kind !== 'any') {
          this.error(
            'E301',
            `a regex pattern requires a \`string\` subject, found \`${formatType(subjectType)}\``,
            pattern.span,
          );
        }
        return;
      case 'objectPattern':
        this.checkObjectPattern(pattern, subjectType, armScope);
        return;
    }
  }

  private checkObjectPattern(pattern: ObjectPattern, subjectType: Type, armScope: Scope): void {
    if (subjectType.kind !== 'object' && subjectType.kind !== 'any') {
      this.error(
        'E301',
        `an object pattern requires an object subject, found \`${formatType(subjectType)}\``,
        pattern.span,
      );
    }
    for (const field of pattern.fields) {
      let fieldType: Type = anyType;
      if (subjectType.kind === 'object') {
        fieldType = subjectType.fields.get(field.key) ?? subjectType.rest ?? anyType;
      }
      this.declareOrRedeclare(armScope, {
        name: field.binding,
        type: fieldType,
        mutable: false,
        span: field.bindingSpan,
        used: false,
      });
    }
  }

  // ---- narrowing --------------------------------------------------------------------------------

  private narrowingsFromTypedCondition(cond: Expr): Narrowing[] {
    if (cond.kind === 'binary' && cond.op === '&&') {
      return [
        ...this.narrowingsFromTypedCondition(cond.left),
        ...this.narrowingsFromTypedCondition(cond.right),
      ];
    }
    const single = this.singleNarrowing(cond);
    return single === undefined ? [] : [single];
  }

  private singleNarrowing(cond: Expr): Narrowing | undefined {
    if (cond.kind === 'is') {
      const key = narrowKey(cond.subject);
      const type = typeFromKindName(cond.typeName);
      if (key !== undefined && type !== undefined) return { key, type };
      return undefined;
    }
    if (cond.kind === 'call' && cond.callee.kind === 'identifier') {
      const match = /^is_(.+)$/.exec(cond.callee.name);
      const firstArg = cond.args[0];
      if (match !== null && cond.args.length === 1 && firstArg?.kind === 'positional') {
        const type = typeFromKindName(match[1]!);
        const key = narrowKey(firstArg.value);
        if (key !== undefined && type !== undefined) return { key, type };
      }
    }
    return undefined;
  }

  private withNarrowings<T>(
    narrowings: readonly Narrowing[],
    mode: 'meet' | 'subtract',
    fn: () => T,
  ): T {
    if (narrowings.length === 0) return fn();
    const saved = new Map<string, Type | undefined>();
    for (const n of narrowings) {
      if (!saved.has(n.key)) saved.set(n.key, this.narrow.get(n.key));
      const base = this.narrow.get(n.key) ?? anyType;
      this.narrow.set(
        n.key,
        mode === 'meet' ? meetTypes(base, n.type) : subtractType(base, n.type),
      );
    }
    try {
      return fn();
    } finally {
      for (const [key, prev] of saved) {
        if (prev === undefined) this.narrow.delete(key);
        else this.narrow.set(key, prev);
      }
    }
  }

  // ---- unused variables ---------------------------------------------------------------------

  private checkUnusedInScope(scope: Scope): void {
    for (const binding of scope.ownBindings()) {
      if (binding.used || binding.name.startsWith('_')) continue;
      if (binding.isErrorCapture) {
        this.warn(
          'W502',
          `unused error binding '${binding.name}'; use \`let v, _ = expr\` if the failure reason does not matter`,
          binding.span,
        );
      } else {
        this.warn('W503', `unused variable '${binding.name}'`, binding.span);
      }
    }
  }
}

// ---- free functions ---------------------------------------------------------------------------

function pathKey(segments: readonly (string | number)[]): string {
  return `path:${JSON.stringify(segments)}`;
}

function narrowKey(expr: Expr): string | undefined {
  if (expr.kind === 'identifier') return `id:${expr.name}`;
  if (expr.kind === 'path') return pathKey(expr.segments);
  return undefined;
}

function pathType(schema: Type, segments: readonly (string | number)[]): Type {
  let current = schema;
  for (const segment of segments) {
    if (current.kind === 'any') return anyType;
    if (typeof segment === 'string') {
      if (current.kind !== 'object') return anyType;
      const field = current.fields.get(segment);
      if (field !== undefined) {
        current = field;
        continue;
      }
      if (current.rest !== undefined) {
        current = current.rest;
        continue;
      }
      return nullType;
    }
    if (current.kind !== 'array') return anyType;
    current = current.element;
  }
  return current;
}

interface WritePathResolution {
  readonly type: Type;
  readonly error?: undefined;
}

interface WritePathError {
  readonly type?: undefined;
  readonly error: string;
}

/**
 * Like {@link pathType}, but for a write target under `validateWrites`: walking into a concrete,
 * non-object/array shape, or past a closed object's known fields with no `rest`, is a hard error
 * (a precise "no such field" message) instead of silently typing the write `null`/`any` — a schema
 * that is meant to validate writes has to say when a write target doesn't exist at all.
 */
function resolveWritePathType(
  schema: Type,
  segments: readonly (string | number)[],
): WritePathResolution | WritePathError {
  let current = schema;
  for (const segment of segments) {
    if (current.kind === 'any') return { type: anyType };
    if (typeof segment === 'string') {
      if (current.kind !== 'object') {
        return { error: `cannot assign through a field of type \`${formatType(current)}\`` };
      }
      const field = current.fields.get(segment);
      if (field !== undefined) {
        current = field;
        continue;
      }
      if (current.rest !== undefined) {
        current = current.rest;
        continue;
      }
      const suggestion = didYouMean(segment, [...current.fields.keys()]);
      const hint = suggestion === undefined ? '' : ` (did you mean '.${suggestion}'?)`;
      return { error: `type \`${formatType(current)}\` has no field '${segment}'${hint}` };
    }
    if (current.kind !== 'array') {
      return { error: `cannot index into type \`${formatType(current)}\` with \`[]\`` };
    }
    current = current.element;
  }
  return { type: current };
}

function typeIncludesNull(type: Type): boolean {
  if (type.kind === 'any' || type.kind === 'null') return true;
  if (type.kind === 'union') return type.members.some(typeIncludesNull);
  return false;
}

function nonNullOf(type: Type): Type {
  if (type.kind === 'null') return neverType;
  if (type.kind === 'any') return anyType;
  if (type.kind === 'union') return subtractType(type, nullType);
  return type;
}

/**
 * Whether an argument of type `argType` is *guaranteed* to satisfy a parameter declared as
 * `paramType`, for the design.md §5 "wrong argument type makes the call fallible" rule.
 *
 * This is deliberately not {@link isSubtype}: `isSubtype` treats `any` as compatible with
 * everything in both directions (a general escape hatch for gradual typing), but here an `any`
 * *argument* against a concrete parameter type is exactly the unguaranteed case design.md's
 * `upcase(.message)` example calls out — it must count as a possible mismatch, not a free pass.
 */
function isGuaranteedMatch(argType: Type, paramType: Type): boolean {
  if (paramType.kind === 'any') return true;
  if (argType.kind === 'any') return false;
  return isSubtype(argType, paramType);
}

/**
 * Whether every value `subjectType` can hold is covered by `coveredType` (the union of a
 * `match`'s kind-pattern arms), for the E309 exhaustiveness check. Like {@link isGuaranteedMatch},
 * this cannot use `isSubtype` directly: an `any`-typed subject is never exhaustively covered by a
 * finite set of kind patterns (only a wildcard `_` arm can do that).
 */
function isExhaustive(subjectType: Type, coveredType: Type): boolean {
  if (subjectType.kind === 'any') return false;
  if (subjectType.kind === 'union') {
    return subjectType.members.every((m) => isExhaustive(m, coveredType));
  }
  return isSubtype(subjectType, coveredType);
}

function comparable(a: Type, b: Type): boolean {
  return a.kind === 'any' || b.kind === 'any' || isSubtype(a, b) || isSubtype(b, a);
}

function literalKey(
  value: IntLiteral | FloatLiteral | StringLiteral | BoolLiteral | NullLiteral,
): string {
  switch (value.kind) {
    case 'int':
      return `int:${String(value.value)}`;
    case 'float':
      return `float:${String(value.value)}`;
    case 'string':
      // A `StringLiteral` has no `.value`: its text lives in `.parts`. Two plain-text patterns
      // with the same text must produce the same key (this is what E310 checks for), so this
      // reconstructs the literal text rather than keying on the AST shape (which would make every
      // string pattern — having no `.value` field at all — collapse to the same key: see the
      // regression test for the false-positive E310 this previously caused on any two distinct
      // string patterns in one `match`). An interpolated string can't appear as a literal pattern
      // (the parser only accepts a plain string here), so `.parts` is always a single text part.
      return `string:${JSON.stringify(value.parts.map((p) => (p.kind === 'text' ? p.value : '')).join(''))}`;
    case 'bool':
      return `bool:${String(value.value)}`;
    case 'null':
      return 'null';
  }
}
