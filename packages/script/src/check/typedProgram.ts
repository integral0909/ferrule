import type { CallExpr, Expr, Program } from '../syntax/ast.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type { FunctionRegistry, FunctionSignature } from '../registry/signature.js';
import type { ExprType, Type } from '../types/types.js';

/** The function signature a particular call site was resolved against. */
export interface ResolvedCall {
  readonly signature: FunctionSignature;
}

/**
 * The checker's output: the program the front end's later stages (a compiler, in a later
 * milestone) consume.
 *
 * Every expression node's resolved type and fallibility is available through {@link types} —
 * this is the "typed program representation" design.md's compilation pipeline needs: rather than
 * a second parallel tree that mirrors {@link Program} node-for-node, the original AST is
 * annotated out of band by node identity, which a compiler walks exactly like the parser's AST
 * (same shapes, same spans) while looking up `types.get(node)` for the type/fallibility a
 * specialized code path needs, and `calls.get(node)` for which {@link FunctionSignature} a call
 * was resolved to (so it does not need to repeat name/overload resolution).
 */
export interface CheckResult {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
  readonly types: ReadonlyMap<Expr, ExprType>;
  readonly calls: ReadonlyMap<CallExpr, ResolvedCall>;
  /** Convenience accessor equivalent to `types.get(expr)`, defaulting to `any` (unfallible). */
  typeOf(expr: Expr): ExprType;
}

export interface CheckOptions {
  /** Defaults to {@link createDefaultRegistry} from `registry/builtins.js`. */
  readonly registry?: FunctionRegistry;
  /**
   * The event's field shape, as a `Type` (normally built with `objectType(...)`). Defaults to an
   * open `any` shape, matching design.md §3: "paths... have type `any` unless an input schema is
   * declared".
   */
  readonly inputSchema?: Type;
}
