import type { FunctionSignature } from '../registry/signature.js';

/** Builds a {@link FunctionSignature} with named fields instead of a long positional list. */
export function fn(
  name: string,
  params: FunctionSignature['params'],
  returnType: FunctionSignature['returnType'],
  fallible: FunctionSignature['fallible'],
  pure: boolean,
  docs: string,
  examples: readonly string[] = [],
): FunctionSignature {
  return { name, params, returnType, fallible, pure, docs, examples };
}
