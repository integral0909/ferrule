import type { Expr } from '../syntax/ast.js';
import type { ExprType, Type } from '../types/types.js';

/**
 * Why a call to this function might be fallible, independent of the generic "wrong argument
 * type" rule (design.md §5: passing a mismatched argument makes *any* call fallible).
 *
 * - `'always'` — the function can fail even when every argument has exactly the declared type
 *   (e.g. `to_int`: a syntactically valid `any` doesn't mean the text is a number).
 * - `'on-argument-mismatch'` — the function cannot fail when arguments match their declared
 *   types exactly, but at least one parameter's declared type is narrower than `any`, so a
 *   mismatch is possible and the checker's generic rule can still make a call to it fallible.
 * - `'never'` — the function cannot fail under any circumstance a well-typed call can produce
 *   (typically because every parameter accepts `any`).
 */
export type Fallibility = 'always' | 'on-argument-mismatch' | 'never';

/** The declared type of a single closure parameter, for documentation and checking. */
export interface ClosureParamSpec {
  readonly name: string;
  readonly type: Type;
}

/** Marks a {@link FunctionParam} as accepting a closure (a higher-order function parameter). */
export interface ClosureSignature {
  readonly params: readonly ClosureParamSpec[];
}

export interface FunctionParam {
  readonly name: string;
  readonly type: Type;
  readonly optional: boolean;
  readonly namedOnly: boolean;
  readonly defaultDoc: string | undefined;
  readonly closure: ClosureSignature | undefined;
  /**
   * When true, the *argument expression* itself (not its runtime value) must be a path, e.g.
   * `del(.a)` needs to know which field to remove. The checker enforces this syntactically.
   */
  readonly requiresPathArgument: boolean;
  readonly doc: string;
}

export interface ClosureCallContext {
  /** The closure argument's declared return type, if the call site passed one. */
  readonly closureReturn: ExprType | undefined;
  /**
   * The argument *expression* actually passed for each parameter, in `params` declaration order
   * (`undefined` where an optional parameter was not supplied). Optional: only the checker
   * supplies it (`check/checker.ts`'s `checkResolvedCall`); `resolveReturnType`'s other caller
   * (`registry.test.ts`) omits it. A return-type rule that wants to key its result on a literal
   * argument — e.g. `parse_regex` inferring an object shape from a constant pattern's named
   * capture groups — inspects `argExprs[i].kind` itself (`'string'`/`'regex'`/...); most rules
   * (`map_values`, `filter`, `compact`, ...) don't need this and can ignore it.
   */
  readonly argExprs?: readonly (Expr | undefined)[];
}

/**
 * Computes a call's return type from its (already-checked) argument types. Used by higher-order
 * functions like `map_values`/`filter` whose result shape depends on their input and closure.
 */
export type ReturnTypeRule = (argTypes: readonly ExprType[], ctx: ClosureCallContext) => Type;

export interface FunctionSignature {
  readonly name: string;
  readonly params: readonly FunctionParam[];
  readonly returnType: Type | ReturnTypeRule;
  readonly fallible: Fallibility;
  /** Pure functions have no side effect and no dependency on anything but their arguments. */
  readonly pure: boolean;
  readonly docs: string;
  readonly examples: readonly string[];
}

export function resolveReturnType(
  sig: FunctionSignature,
  argTypes: readonly ExprType[],
  ctx: ClosureCallContext,
): Type {
  return typeof sig.returnType === 'function' ? sig.returnType(argTypes, ctx) : sig.returnType;
}

/** Builder for a {@link FunctionParam} with convenient defaults. */
export function param(
  name: string,
  type: Type,
  options: Partial<FunctionParam> = {},
): FunctionParam {
  return {
    name,
    type,
    optional: options.optional ?? false,
    namedOnly: options.namedOnly ?? false,
    defaultDoc: options.defaultDoc,
    closure: options.closure,
    requiresPathArgument: options.requiresPathArgument ?? false,
    doc: options.doc ?? '',
  };
}

/** A registry of standard-library function signatures, keyed by name. */
export class FunctionRegistry {
  private readonly byName = new Map<string, FunctionSignature>();

  register(signature: FunctionSignature): this {
    if (this.byName.has(signature.name)) {
      throw new Error(`function '${signature.name}' is already registered`);
    }
    this.byName.set(signature.name, signature);
    return this;
  }

  get(name: string): FunctionSignature | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get size(): number {
    return this.byName.size;
  }

  names(): readonly string[] {
    return [...this.byName.keys()].sort();
  }

  all(): readonly FunctionSignature[] {
    return [...this.byName.values()];
  }
}
