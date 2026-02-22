/**
 * Compile-time slot allocation for local variables (`let`, `let mut`, `let v, err`, closure
 * parameters, and `match` object-pattern bindings).
 *
 * The checker already proved every program is well-scoped (no undefined variables, no illegal
 * redeclaration), so the compiler's own scope tracking only needs to reproduce the same lexical
 * nesting to resolve each name to a slot number — it does not repeat any of the checker's
 * validation. One {@link SlotAllocator} is shared for an entire program: slots are never reused
 * across sibling scopes (a `let` in one `if` branch and a `let` in another each get their own
 * slot), trading a little extra `Frame` array size for a compiler with no lifetime analysis to
 * get wrong. Program sizes design.md targets (bounded, no recursion) make this cheap in practice.
 */
export class SlotAllocator {
  private count = 0;

  next(): number {
    return this.count++;
  }

  get slotCount(): number {
    return this.count;
  }
}

export class CompileScope {
  private readonly slots = new Map<string, number>();

  constructor(
    private readonly alloc: SlotAllocator,
    private readonly parent?: CompileScope,
  ) {}

  /** Allocates a fresh slot for `name` in this scope and returns it. */
  declare(name: string): number {
    const slot = this.alloc.next();
    this.slots.set(name, slot);
    return slot;
  }

  /** Resolves `name` to a slot, searching enclosing scopes. Assumes the checker validated scoping. */
  resolve(name: string): number {
    const slot = this.slots.get(name);
    if (slot !== undefined) return slot;
    if (this.parent === undefined) {
      throw new Error(`internal error: compiler could not resolve '${name}' to a slot`);
    }
    return this.parent.resolve(name);
  }

  child(): CompileScope {
    return new CompileScope(this.alloc, this);
  }
}
