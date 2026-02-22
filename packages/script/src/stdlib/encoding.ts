import {
  encodeJson,
  fromBase64,
  fromHex,
  toBase64,
  toHex,
  utf8Encode,
  type Value,
} from '@ferrule/core';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import type { RuntimeValue } from '../runtime/context.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { checkStringLength } from '../runtime/limits.js';
import { containsRegex } from '../runtime/regex.js';
import { anyType, boolType, bytesType, stringType, unionType } from '../types/types.js';
import { fn } from './helpers.js';

const stringOrBytesType = unionType([stringType, bytesType]);

/**
 * Encoding: `encode_json`, `encode_base64`/`decode_base64`, `encode_hex`/`decode_hex`,
 * `encode_percent`/`decode_percent`. `@ferrule/core`'s `encodeJson`, `toBase64`/`fromBase64`, and
 * `toHex`/`fromHex` do the heavy lifting; these functions mostly validate arguments and translate
 * exceptions into `Failure`.
 */
export function registerEncoding(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'encode_json',
      [
        param('value', anyType, { doc: 'the value to encode' }),
        param('pretty', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      stringType,
      'always',
      true,
      'Encodes a value as JSON. `pretty: true` indents the output with 2 spaces; fails for a value that cannot be represented as JSON, such as a regex value or a NaN/infinite float.',
      ['encode_json(.event)!', 'encode_json(.event, pretty: true)!'],
    ),
  );
  impls?.register(
    impl('encode_json', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (containsRegex(v)) return new Failure('encode_json cannot encode a regex value');
      const prettyArg = args.named.get('pretty');
      const pretty = prettyArg === true;
      let text: string;
      try {
        text = encodeJson(v as Value, { indent: pretty ? 2 : 0, nonFinite: 'error' });
      } catch (error) {
        return new Failure(
          `encode_json: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      checkStringLength(text.length, ctx.limits, span);
      return text;
    }),
  );

  registry.register(
    fn(
      'encode_base64',
      [
        param('value', stringOrBytesType, { doc: 'the string or bytes to encode' }),
        param('url_safe', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      stringType,
      'on-argument-mismatch',
      true,
      'Encodes a string (as UTF-8) or bytes as base64. `url_safe: true` uses the URL-and-filename-safe alphabet (`-`/`_` instead of `+`/`/`, no padding).',
      ['encode_base64(.payload)', 'encode_base64(.token, url_safe: true)'],
    ),
  );
  impls?.register(
    impl('encode_base64', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const bytes = toBytes(v);
      if (bytes === null) {
        return new Failure(`encode_base64 requires a string or bytes, found ${scriptKindOf(v)}`);
      }
      const urlSafe = args.named.get('url_safe') === true;
      const text = toBase64(bytes, urlSafe ? 'url' : 'standard');
      checkStringLength(text.length, ctx.limits, span);
      return text;
    }),
  );

  registry.register(
    fn(
      'decode_base64',
      [
        param('value', stringType, { doc: 'the base64 text to decode' }),
        param('url_safe', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      bytesType,
      'always',
      true,
      'Decodes base64 text to bytes. Fails if `value` is not valid base64 for the chosen alphabet. `url_safe: true` decodes the URL-and-filename-safe alphabet.',
      ['decode_base64(.payload)!'],
    ),
  );
  impls?.register(
    impl('decode_base64', (args) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`decode_base64 requires a string, found ${scriptKindOf(v)}`);
      }
      const urlSafe = args.named.get('url_safe') === true;
      try {
        return fromBase64(v, urlSafe ? 'url' : 'standard');
      } catch (error) {
        return new Failure(
          `decode_base64: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  registry.register(
    fn(
      'encode_hex',
      [param('value', stringOrBytesType, { doc: 'the string or bytes to encode' })],
      stringType,
      'on-argument-mismatch',
      true,
      'Encodes a string (as UTF-8) or bytes as lowercase hexadecimal.',
      ['encode_hex(.digest)'],
    ),
  );
  impls?.register(
    impl('encode_hex', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const bytes = toBytes(v);
      if (bytes === null) {
        return new Failure(`encode_hex requires a string or bytes, found ${scriptKindOf(v)}`);
      }
      const text = toHex(bytes);
      checkStringLength(text.length, ctx.limits, span);
      return text;
    }),
  );

  registry.register(
    fn(
      'decode_hex',
      [param('value', stringType, { doc: 'the hexadecimal text to decode' })],
      bytesType,
      'always',
      true,
      'Decodes hexadecimal text (either case) to bytes. Fails on an odd-length string or a non-hex character.',
      ['decode_hex(.digest)!'],
    ),
  );
  impls?.register(
    impl('decode_hex', (args) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`decode_hex requires a string, found ${scriptKindOf(v)}`);
      }
      try {
        return fromHex(v);
      } catch (error) {
        return new Failure(`decode_hex: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  registry.register(
    fn(
      'encode_percent',
      [
        param('value', stringType, { doc: 'the text to percent-encode' }),
        param('component', boolType, { optional: true, namedOnly: true, defaultDoc: 'true' }),
      ],
      stringType,
      'always',
      true,
      "Percent-encodes text for use in a URL. `component: true` (default) encodes a single URI component, like JavaScript's `encodeURIComponent` (escapes `/`, `:`, `?`, `&`, `=`, ...); `component: false` encodes a whole URI, like `encodeURI` (leaves those reserved characters alone). Fails only if `value` contains an unpaired UTF-16 surrogate.",
      ['encode_percent(.query)!', 'encode_percent(.url, component: false)!'],
    ),
  );
  impls?.register(
    impl('encode_percent', (args) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`encode_percent requires a string, found ${scriptKindOf(v)}`);
      }
      const component = args.named.get('component');
      const useComponent = component === undefined ? true : component === true;
      try {
        return useComponent ? encodeURIComponent(v) : encodeURI(v);
      } catch (error) {
        return new Failure(
          `encode_percent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  registry.register(
    fn(
      'decode_percent',
      [param('value', stringType, { doc: 'the percent-encoded text to decode' })],
      stringType,
      'always',
      true,
      'Decodes percent-encoded (URL-encoded) text. Fails on a malformed `%XX` escape sequence.',
      ['decode_percent(.query)!'],
    ),
  );
  impls?.register(
    impl('decode_percent', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`decode_percent requires a string, found ${scriptKindOf(v)}`);
      }
      let text: string;
      try {
        text = decodeURIComponent(v);
      } catch (error) {
        return new Failure(
          `decode_percent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      checkStringLength(text.length, ctx.limits, span);
      return text;
    }),
  );
}

/** Encodes a `string` (as UTF-8) or returns `Uint8Array` bytes as-is; `null` for anything else. */
function toBytes(v: RuntimeValue): Uint8Array | null {
  if (typeof v === 'string') return utf8Encode(v);
  if (v instanceof Uint8Array) return v;
  return null;
}
