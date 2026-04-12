import { builtinOperators } from '@ferrule/operators';
import type { ComponentDefinition } from '@ferrule/runtime';
import { ComponentRegistry } from '@ferrule/runtime';
import { builtinSinks } from '@ferrule/sinks';
import { builtinSources } from '@ferrule/sources';

/** Every built-in source, transform, and sink definition `ferrule` ships with, in a stable order. */
export function builtinComponents(): readonly ComponentDefinition[] {
  return [...builtinSources(), ...builtinOperators(), ...builtinSinks()];
}

/** Builds the `ComponentRegistry` used by `run`, `validate`, `test`, `generate`, `list`, and `describe`. */
export function buildDefaultRegistry(): ComponentRegistry {
  return new ComponentRegistry().register(...builtinComponents());
}
