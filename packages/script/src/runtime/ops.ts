import { kindOf, valuesEqual, wrapInt64, type Value } from '@ferrule/core';
import type { BinaryOp } from '../syntax/ast.js';
import type { Span } from '../syntax/source.js';
import type { RuntimeValue } from './context.js';
import { failure, type Failure } from './failure.js';
import { isRegexValue } from './regex.js';
import { abortSignal } from './signal.js';

/**
 * Shared operator semantics for arithmetic, comparison, and equality, used in two places that
 * must never drift apart: `compile/expr.ts`'s dynamic fallback for `any`-typed operands (the type
 * is not known until the operator actually runs), and `compile/optimizer.ts`'s constant folding
 * (which needs to evaluate an operator at compile time exactly as it would run). Statically-typed
 * operands (both sides known `int`, both `float`, ...) skip this module entirely — `compile/
 * expr.ts` emits a closure that does the one required operation directly, with no kind dispatch,
 * no `Failure` check, and no function-object call; see the README's "Compiler architecture".
 */

type RV = RuntimeValue;

/** Runtime-dispatched `+ - * / %`. `any`-typed operands only: see the module doc. */
export function dynamicArithmetic(op: BinaryOp, a: RV, b: RV, span: Span): RV | Failure {
  if (typeof a === 'bigint' && typeof b === 'bigint') return intArithmetic(op, a, b);
  if (typeof a === 'number' && typeof b === 'number') return floatArithmetic(op, a, b);
  if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  throw abortSignal(`cannot apply '${op}' to ${describeKind(a)} and ${describeKind(b)}`, span);
}

export function intArithmetic(op: BinaryOp, a: bigint, b: bigint): bigint | Failure {
  switch (op) {
    case '+':
      return wrapInt64(a + b);
    case '-':
      return wrapInt64(a - b);
    case '*':
      return wrapInt64(a * b);
    case '/':
      return b === 0n ? failure('division by zero') : wrapInt64(a / b);
    case '%':
      return b === 0n ? failure('division by zero') : wrapInt64(a % b);
    default:
      throw new Error(`internal error: '${op}' is not an arithmetic operator`);
  }
}

export function floatArithmetic(op: BinaryOp, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    default:
      throw new Error(`internal error: '${op}' is not an arithmetic operator`);
  }
}

/** Runtime-dispatched `< <= > >=`. `any`-typed operands only. */
export function dynamicRelational(op: BinaryOp, a: RV, b: RV, span: Span): boolean {
  if (typeof a === 'bigint' && typeof b === 'bigint') return relational(op, a < b, a > b);
  if (typeof a === 'number' && typeof b === 'number') return relational(op, a < b, a > b);
  if (typeof a === 'string' && typeof b === 'string') return relational(op, a < b, a > b);
  throw abortSignal(`cannot apply '${op}' to ${describeKind(a)} and ${describeKind(b)}`, span);
}

function relational(op: BinaryOp, less: boolean, greater: boolean): boolean {
  switch (op) {
    case '<':
      return less;
    case '<=':
      return !greater;
    case '>':
      return greater;
    case '>=':
      return !less;
    default:
      throw new Error(`internal error: '${op}' is not a relational operator`);
  }
}

/**
 * `==`/`!=`. Works for any pair the checker allows through `comparable()`, including a regex
 * (equal only by reference) at any depth inside an array/object — `@ferrule/core`'s `valuesEqual`
 * knows nothing about `RegexValue`, so containers are walked here and only leaves (which, past
 * this point, cannot be a regex or a container) are handed to it.
 */
export function runtimeEquals(a: RV, b: RV): boolean {
  if (isRegexValue(a) || isRegexValue(b)) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => runtimeEquals(v, b[i]!));
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      const bv = b.get(k);
      if (bv === undefined || !runtimeEquals(v, bv)) return false;
    }
    return true;
  }
  return valuesEqual(a, b as Value);
}

function describeKind(value: RV): string {
  return isRegexValue(value) ? 'regex' : kindOf(value as Value);
}
