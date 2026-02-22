import { ImplementationRegistry } from '../registry/implementation.js';
import { FunctionRegistry } from '../registry/signature.js';
import { registerCollections } from './collections.js';
import { registerCoreImplementations } from './core.js';
import { registerEncoding } from './encoding.js';
import { registerHashing } from './hashing.js';
import { registerMisc } from './misc.js';
import { registerNumbers } from './numbers.js';
import { registerParsing } from './parsing.js';
import { registerRedact } from './redact.js';
import { registerStrings } from './strings.js';
import { registerTypeChecks } from './typeChecks.js';

/**
 * Registers every standard library function this milestone defines beyond the checker's own
 * fixture set (`registry/builtins.ts`'s inline `registerBuiltins`): type checks/coercion,
 * strings, parsing, encoding, numbers/time, collections, hashing/IDs, and `assert`/`log`.
 *
 * `impls` is optional so `registry/builtins.ts`'s `createDefaultRegistry()` — used throughout the
 * front end, including by callers that only type-check and never run a program — can register
 * every signature without needing an `ImplementationRegistry`. Passing one (as
 * {@link createDefaultImplementations} does) also registers every implementation, co-located with
 * its signature in the same call per function.
 */
export function registerStdlib(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerTypeChecks(registry, impls);
  registerStrings(registry, impls);
  registerParsing(registry, impls);
  registerEncoding(registry, impls);
  registerNumbers(registry, impls);
  registerCollections(registry, impls);
  registerHashing(registry, impls);
  registerRedact(registry, impls);
  registerMisc(registry, impls);
  if (impls !== undefined) registerCoreImplementations(impls);
}

/**
 * The default `ImplementationRegistry`, matching `registry/builtins.ts`'s `createDefaultRegistry()`.
 * Builds its own throwaway `FunctionRegistry` to satisfy `registerStdlib`'s combined signature —
 * `createDefaultRegistry()` builds the real one separately.
 */
export function createDefaultImplementations(): ImplementationRegistry {
  const impls = new ImplementationRegistry();
  registerStdlib(new FunctionRegistry(), impls);
  return impls;
}
