import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { checkStringLength } from '../runtime/limits.js';
import { resolvePatternForIteration } from '../runtime/patternResolve.js';
import { redactIpAddress } from '../runtime/ipAddress.js';
import { arrayType, intType, regexType, stringType, unionType } from '../types/types.js';
import { fn } from './helpers.js';

/** A `redact` pattern element: a literal string, or a regex. */
const patternsType = arrayType(unionType([stringType, regexType]));

/**
 * Redaction: `redact_ip` (zero address bits beyond a keep prefix), `redact` (replace every match
 * of one or more patterns with a placeholder), `mask` (blank out the middle of a string, keeping
 * a prefix/suffix). These exist for the common "cost control... field redaction" story
 * (`README.md`'s "Why Ferrule" list) — stripping or reducing the specificity of sensitive fields
 * before they reach storage.
 */
export function registerRedact(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerRedactIp(registry, impls);
  registerRedactField(registry, impls);
  registerMask(registry, impls);
}

// ---- redact_ip ----------------------------------------------------------------------------

function registerRedactIp(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'redact_ip',
      [
        param('value', stringType, { doc: 'an IPv4 or IPv6 address, as text' }),
        param('keep_prefix', intType, {
          doc: 'bits to keep from the start of the address; the rest are zeroed (0-32 for IPv4, 0-128 for IPv6)',
        }),
      ],
      stringType,
      'always',
      true,
      'Redacts an IP address by zeroing every address bit beyond `keep_prefix`, keeping only the ' +
        'network portion — e.g. `redact_ip("203.0.113.5", keep_prefix: 24)` is `"203.0.113.0"` ' +
        '(a /24). Works on both IPv4 (dotted-quad) and IPv6 (including `::`-compressed) text; ' +
        'fails if `value` is not a valid address, or `keep_prefix` is out of range for the ' +
        "address's width. Does not support IPv6's embedded-IPv4 tail form (`::ffff:192.0.2.1`).",
      ['.client_ip = redact_ip(parsed.ip, keep_prefix: 24) ?? "0.0.0.0"'],
    ),
  );
  impls?.register(
    impl('redact_ip', (args) => {
      const value = args.positional[0] ?? null;
      const keepPrefix = args.positional[1] ?? null;
      if (typeof value !== 'string') {
        return new Failure(`redact_ip requires a string value, found ${scriptKindOf(value)}`);
      }
      if (typeof keepPrefix !== 'bigint') {
        return new Failure(
          `redact_ip requires an int keep_prefix, found ${scriptKindOf(keepPrefix)}`,
        );
      }
      const result = redactIpAddress(value, Number(keepPrefix));
      return result.ok ? result.value : new Failure(`redact_ip: ${result.message}`);
    }),
  );
}

// ---- redact ---------------------------------------------------------------------------------

function registerRedactField(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'redact',
      [
        param('value', stringType, { doc: 'the text to redact' }),
        param('patterns', patternsType, {
          doc: 'literal strings and/or regexes; each match of each pattern is replaced, in order',
        }),
        param('replacement', stringType, {
          optional: true,
          namedOnly: true,
          defaultDoc: '"[REDACTED]"',
        }),
      ],
      stringType,
      'always',
      true,
      'Replaces every match of every pattern in `patterns` with `replacement` (default ' +
        '`"[REDACTED]"`), applying patterns in order (each sees the previous pattern\'s output). ' +
        'A `string` pattern is a literal substring (like `replace`, not a regex); a `regex` ' +
        'pattern matches globally regardless of the flags it was compiled with. Fails if any ' +
        'string in `patterns` cannot be used (never, for a literal), or if any `regex` element ' +
        'is somehow invalid — in practice this only fails on the resource-limit path.',
      ['redact(.message, [r/\\b\\d{16}\\b/, .username], replacement: "[REDACTED]")!'],
    ),
  );
  impls?.register(
    impl('redact', (args, ctx, span) => {
      const value = args.positional[0] ?? null;
      const patterns = args.positional[1] ?? null;
      if (typeof value !== 'string') {
        return new Failure(`redact requires a string value, found ${scriptKindOf(value)}`);
      }
      if (!Array.isArray(patterns)) {
        return new Failure(`redact requires an array of patterns, found ${scriptKindOf(patterns)}`);
      }
      const replacementArg = args.named.get('replacement');
      const replacement = typeof replacementArg === 'string' ? replacementArg : '[REDACTED]';

      let result = value;
      for (const pattern of patterns) {
        if (typeof pattern === 'string') {
          result = pattern.length === 0 ? result : result.split(pattern).join(replacement);
          continue;
        }
        const resolved = resolvePatternForIteration(pattern);
        if (!resolved.ok) return new Failure(`redact: ${resolved.message}`);
        result = result.replace(resolved.regex, replacement);
      }
      checkStringLength(result.length, ctx.limits, span);
      return result;
    }),
  );
}

// ---- mask -------------------------------------------------------------------------------------

function registerMask(registry: FunctionRegistry, impls: ImplementationRegistry | undefined): void {
  registry.register(
    fn(
      'mask',
      [
        param('value', stringType, { doc: 'the text to mask' }),
        param('keep_start', intType, { optional: true, namedOnly: true, defaultDoc: '0' }),
        param('keep_end', intType, { optional: true, namedOnly: true, defaultDoc: '4' }),
        param('char', stringType, { optional: true, namedOnly: true, defaultDoc: '"*"' }),
      ],
      stringType,
      'always',
      true,
      'Replaces the middle of `value` with `char`, keeping the first `keep_start` and last ' +
        '`keep_end` characters visible (default: mask everything but the last 4 characters, for ' +
        'e.g. showing only the last 4 digits of a card or token number). `char` is repeated once ' +
        'per masked character, so the result is always the same length as `value` when `char` is ' +
        'a single character. If `keep_start + keep_end` covers the whole string, `value` is ' +
        'returned unchanged (nothing to mask). Fails if `keep_start`/`keep_end` is negative.',
      ['mask(.card_number)', 'mask(.card_number, keep_start: 4, keep_end: 4)'],
    ),
  );
  impls?.register(
    impl('mask', (args, ctx, span) => {
      const value = args.positional[0] ?? null;
      if (typeof value !== 'string') {
        return new Failure(`mask requires a string value, found ${scriptKindOf(value)}`);
      }
      const keepStartArg = args.named.get('keep_start');
      const keepEndArg = args.named.get('keep_end');
      const charArg = args.named.get('char');
      const keepStart = typeof keepStartArg === 'bigint' ? Number(keepStartArg) : 0;
      const keepEnd = typeof keepEndArg === 'bigint' ? Number(keepEndArg) : 4;
      const char = typeof charArg === 'string' ? charArg : '*';
      if (keepStart < 0) {
        return new Failure(`mask requires a non-negative keep_start, found ${keepStart}`);
      }
      if (keepEnd < 0) {
        return new Failure(`mask requires a non-negative keep_end, found ${keepEnd}`);
      }

      if (keepStart + keepEnd >= value.length) return value;
      const maskedLength = value.length - keepStart - keepEnd;
      const result =
        value.slice(0, keepStart) + char.repeat(maskedLength) + value.slice(value.length - keepEnd);
      checkStringLength(result.length, ctx.limits, span);
      return result;
    }),
  );
}
