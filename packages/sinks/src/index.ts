import type { SinkDefinition } from '@ferrule/runtime';
import { httpFamilySinks } from './http-family.js';
import { streamFamilySinks } from './stream-family.js';

export * from './http-family.js';
export * from './stream-family.js';

/** Every built-in sink definition. */
export function builtinSinks(): SinkDefinition[] {
  return [...httpFamilySinks(), ...streamFamilySinks()];
}
