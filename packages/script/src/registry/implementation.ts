import type { CompiledClosure, RunCtx, RuntimeValue } from '../runtime/context.js';
import type { Failure } from '../runtime/failure.js';
import type { Span } from '../syntax/source.js';

/**
 * The arguments a compiled call site passes to a {@link FunctionImplementation}: already
 * evaluated (and, for `T!` arguments, already unwrapped — see `compile/call.ts`), in the shape
 * the checker resolved them to against the function's {@link FunctionSignature}.
 */
export interface CallArgs {
  /** Every non-closure parameter's value, in declaration order (including defaulted-away
   *  optionals, which are omitted — see `optionalPositional`). */
  readonly positional: readonly RuntimeValue[];
  /** Named-only arguments actually supplied at the call site. */
  readonly named: ReadonlyMap<string, RuntimeValue>;
  /** Closure parameters, compiled to callables, in declaration order. */
  readonly closures: readonly CompiledClosure[];
  /** Whether the argument at each positional index was actually supplied (vs. defaulted). */
  readonly positionalSupplied: readonly boolean[];
}

export type BuiltinCall = (args: CallArgs, ctx: RunCtx, span: Span) => RuntimeValue | Failure;

/**
 * A standard library function's runtime behaviour, paired with its {@link FunctionSignature} by
 * name (see `stdlib/*.ts`, where every function defines both together so the two never drift
 * apart, and `registry/builtins.ts`'s `createDefaultRegistry`/`createDefaultImplementations`,
 * which assemble the whole library from those per-function definitions).
 *
 * Functions are dispatched uniformly through `call`: the compiler evaluates a call's arguments
 * (specializing *how* each argument is evaluated using the checker's static types, and unwrapping
 * `T!` arguments before they reach here — a call is fallible only via its own `call` returning a
 * `Failure`, per design.md §5) and then invokes `call` once. This keeps the standard library easy
 * to extend — a new function is one small module, not a bespoke code-generation path — while the
 * performance-sensitive specialization the language design calls for (int vs. float arithmetic,
 * path shapes, comparison kinds) lives in the operators the compiler itself lowers directly
 * (`compile/expr.ts`), which are the actual hot path for most programs; see the README's
 * "Compiler architecture" section for the measurements behind this split.
 */
export interface FunctionImplementation {
  readonly name: string;
  readonly call: BuiltinCall;
}

export function impl(name: string, call: BuiltinCall): FunctionImplementation {
  return { name, call };
}

/** A registry of standard-library function implementations, keyed by name (mirrors `FunctionRegistry`). */
export class ImplementationRegistry {
  private readonly byName = new Map<string, FunctionImplementation>();

  register(implementation: FunctionImplementation): this {
    if (this.byName.has(implementation.name)) {
      throw new Error(`implementation '${implementation.name}' is already registered`);
    }
    this.byName.set(implementation.name, implementation);
    return this;
  }

  get(name: string): FunctionImplementation | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): readonly string[] {
    return [...this.byName.keys()].sort();
  }
}
