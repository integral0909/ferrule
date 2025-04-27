import type { Span } from '../syntax/source.js';
import type { Type } from '../types/types.js';

export interface Binding {
  readonly name: string;
  readonly type: Type;
  readonly mutable: boolean;
  readonly span: Span;
  /** Mutated by the checker when a read of this binding is seen, for the unused-variable warning. */
  used: boolean;
  /** True for the `err` half of `let v, err = expr`, so an unused one reports W502, not E205. */
  readonly isErrorCapture?: boolean;
}

/**
 * A lexical scope: variable bindings visible in a block, plus a link to the enclosing scope for
 * lookups that fall through. Shadowing an outer binding in a child scope is allowed; redeclaring
 * a name already bound in the *same* scope is a checker error (E203).
 */
export class Scope {
  readonly parent: Scope | undefined;
  private readonly bindings = new Map<string, Binding>();

  constructor(parent?: Scope) {
    this.parent = parent;
  }

  declare(binding: Binding): void {
    this.bindings.set(binding.name, binding);
  }

  declaredHere(name: string): boolean {
    return this.bindings.has(name);
  }

  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }

  /** Every binding declared directly in this scope (not ancestors), for the unused-variable check. */
  ownBindings(): readonly Binding[] {
    return [...this.bindings.values()];
  }

  /** Every name visible from this scope, nearest first, for "did you mean" suggestions. */
  visibleNames(): readonly string[] {
    const names: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      for (const name of scope.bindings.keys()) names.push(name);
      scope = scope.parent;
    }
    return names;
  }

  child(): Scope {
    return new Scope(this);
  }
}
