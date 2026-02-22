import { parseJson } from '@ferrule/core';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import type { RuntimeValue } from '../runtime/context.js';
import { Failure } from '../runtime/failure.js';
import { checkCollectionSize, checkRegexInputLength } from '../runtime/limits.js';
import { scriptKindOf } from '../runtime/kinds.js';

/**
 * Implementations for the functions `registry/builtins.ts` already declares signatures for
 * (`to_int`/`to_string` are in `typeChecks.ts`; `emit`/`now` are in `misc.ts`/`numbers.ts`):
 * `upcase`, `downcase`, `parse_json`, `length`, `map_values`, `filter`. `parse_regex` (and its
 * former self, now `compile_regex`) live in `stdlib/parsing.ts` — see that file for why.
 */
export function registerCoreImplementations(impls: ImplementationRegistry): void {
  impls.register(
    impl('upcase', (args) => {
      const v = args.positional[0] ?? null;
      return typeof v === 'string'
        ? v.toUpperCase()
        : new Failure(`upcase requires a string, found ${scriptKindOf(v)}`);
    }),
  );

  impls.register(
    impl('downcase', (args) => {
      const v = args.positional[0] ?? null;
      return typeof v === 'string'
        ? v.toLowerCase()
        : new Failure(`downcase requires a string, found ${scriptKindOf(v)}`);
    }),
  );

  impls.register(
    impl('parse_json', (args, ctx) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`parse_json requires a string, found ${scriptKindOf(v)}`);
      }
      checkRegexInputLength(v.length, ctx.limits, ctx.currentSpan);
      try {
        return parseJson(v, { maxLength: ctx.limits.maxStringLength });
      } catch (error) {
        return new Failure(
          `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  impls.register(
    impl('length', (args) => {
      const v = args.positional[0] ?? null;
      if (typeof v === 'string') return BigInt(v.length);
      if (v instanceof Uint8Array) return BigInt(v.byteLength);
      if (Array.isArray(v)) return BigInt(v.length);
      if (v instanceof Map) return BigInt(v.size);
      return new Failure(
        `length requires a string, bytes, array, or object, found ${scriptKindOf(v)}`,
      );
    }),
  );

  impls.register(
    impl('map_values', (args, ctx, span) => {
      const input = args.positional[0] ?? null;
      const mapFn = args.closures[0];
      if (!(input instanceof Map) || mapFn === undefined) {
        return new Failure(`map_values requires an object, found ${scriptKindOf(input)}`);
      }
      const out = new Map<string, RuntimeValue>();
      for (const [k, v] of input) {
        const result = mapFn([k, v], ctx);
        if (result instanceof Failure) return result;
        out.set(k, result);
      }
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    }),
  );

  impls.register(
    impl('filter', (args, ctx, span) => {
      const input = args.positional[0] ?? null;
      const predicate = args.closures[0];
      if (!Array.isArray(input) || predicate === undefined) {
        return new Failure(`filter requires an array, found ${scriptKindOf(input)}`);
      }
      const out: RuntimeValue[] = [];
      for (const el of input) {
        const result = predicate([el], ctx);
        if (result instanceof Failure) return result;
        if (result === true) out.push(el);
      }
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );
}
