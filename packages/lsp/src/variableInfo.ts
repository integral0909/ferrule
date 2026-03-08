import {
  handled,
  nullType,
  stringType,
  unionType,
  type CheckResult,
  type ExprType,
} from '@ferrule/script';
import type { ScopeAnalysis, VariableDecl, VariableDeclKind } from './scopeAnalysis.js';

/**
 * Best-effort inferred type for a variable declaration. `let`/`let v, err = expr` read it straight
 * off the checker's own type map via {@link VariableDecl.valueExpr}; a closure parameter or
 * object-pattern field has no such expression (its type comes from the call site the closure was
 * passed to, or the `match` subject), so this falls back to the type recorded at its first usage.
 * Returns `undefined` only for a declared-but-never-used closure parameter/pattern field, where no
 * type was ever recorded anywhere the checker would look at.
 */
export function variableExprType(
  decl: VariableDecl,
  checkResult: CheckResult,
  scopeAnalysis: ScopeAnalysis,
): ExprType | undefined {
  if (decl.kind === 'errCapture') return handled(unionType([stringType, nullType]));
  if (decl.valueExpr !== undefined) return checkResult.typeOf(decl.valueExpr);
  for (const ref of scopeAnalysis.referencesOf(decl)) {
    const type = checkResult.types.get(ref.node);
    if (type !== undefined) return type;
  }
  return undefined;
}

/** A short, human-readable label for what kind of binding a declaration is, for hover/completion. */
export function variableKindLabel(kind: VariableDeclKind): string {
  switch (kind) {
    case 'let':
      return 'let';
    case 'letMut':
      return 'let mut';
    case 'letCaptureValue':
      return 'let (captured value)';
    case 'errCapture':
      return 'let (captured error)';
    case 'closureParam':
      return 'closure parameter';
    case 'objectPatternField':
      return 'match-pattern binding';
  }
}
