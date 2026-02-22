import { isInt64, parseDuration, Timestamp, type Value, type ValueMap } from '@ferrule/core';
import { impl, type CallArgs, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type ClosureCallContext, type FunctionRegistry } from '../registry/signature.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { checkCollectionSize, checkRegexInputLength } from '../runtime/limits.js';
import { resolvePatternForIteration, resolvePatternForMatch } from '../runtime/patternResolve.js';
import { getCachedRegex } from '../runtime/regexCache.js';
import { RegexValue } from '../runtime/regex.js';
import { parseStrftime } from '../runtime/strftime.js';
import type { Expr } from '../syntax/ast.js';
import {
  anyObjectType,
  arrayType,
  boolType,
  intType,
  floatType,
  nullType,
  objectType,
  regexType,
  stringType,
  timestampType,
  type Type,
  unionType,
} from '../types/types.js';
import { fn } from './helpers.js';

/** `string | regex` — accepted everywhere a pattern argument doubles as regex source text. */
const patternType = unionType([stringType, regexType]);

/**
 * Parsing: `parse_regex` (matches and returns named captures as an object — see below),
 * `compile_regex` (the plain "text -> `regex`" constructor; this is what used to be called
 * `parse_regex` before it was redefined to match design.md's/the README's `parse_regex(value,
 * pattern)` shape), `matches`, `parse_regex_all`, `parse_key_value`, `parse_int`, `parse_float`,
 * `parse_timestamp`, `parse_duration`, `parse_url`, `parse_query_string`. `parse_json` is
 * implemented in `stdlib/core.ts` (its signature predates this module).
 */
export function registerParsing(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerParseRegex(registry, impls);
  registerCompileRegex(registry, impls);
  registerMatches(registry, impls);
  registerParseRegexAll(registry, impls);
  registerParseKeyValue(registry, impls);
  registerParseInt(registry, impls);
  registerParseFloat(registry, impls);
  registerParseTimestamp(registry, impls);
  registerParseDuration(registry, impls);
  registerParseUrl(registry, impls);
  registerParseQueryString(registry, impls);
}

// ---- parse_regex ------------------------------------------------------------------------------

/**
 * Best-effort scan for `(?<name>...)` named-capture-group openers in regex source text. Not a
 * full regex parser (doesn't track character classes, so a literal `(?<` written inside `[...]`
 * would be misread — rare in practice) but correctly skips lookbehind assertions (`(?<=`/`(?<!`),
 * since the character after `<` for those is `=`/`!`, neither a valid identifier start.
 */
function extractNamedGroupNames(source: string): string[] {
  const names: string[] = [];
  const re = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g;
  for (const m of source.matchAll(re)) names.push(m[1]!);
  return names;
}

/** The pattern text of a constant (literal) pattern argument, or `undefined` if it isn't one. */
function constantPatternSource(expr: Expr | undefined): string | undefined {
  if (expr === undefined) return undefined;
  if (expr.kind === 'regex') return expr.pattern;
  if (expr.kind === 'string') {
    if (expr.parts.length === 0) return '';
    if (expr.parts.length === 1 && expr.parts[0]!.kind === 'text') return expr.parts[0]!.value;
  }
  return undefined;
}

/**
 * `parse_regex`'s return type: when the `pattern` argument is a constant regex or string literal
 * (and `numeric_groups` isn't a literal `true`), infers a closed `object` type with one `string`
 * field per named capture group, so e.g. `parse_regex(.msg, r'(?<ip>\S+)').ip` type-checks as
 * `string` without falling back to `any`. Anything else (a dynamic pattern, or `numeric_groups:
 * true`, whose field count isn't known statically without fully parsing the pattern) falls back
 * to an open `object { ..any }`.
 */
function parseRegexReturnType(_argTypes: unknown, ctx: ClosureCallContext): Type {
  const numericGroupsExpr = ctx.argExprs?.[2];
  if (numericGroupsExpr?.kind === 'bool' && numericGroupsExpr.value) return anyObjectType;
  const source = constantPatternSource(ctx.argExprs?.[1]);
  if (source === undefined) return anyObjectType;
  const names = extractNamedGroupNames(source);
  if (names.length === 0) return anyObjectType;
  return objectType(Object.fromEntries(names.map((n) => [n, stringType])));
}

function registerParseRegex(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_regex',
      [
        param('value', stringType, { doc: 'the text to match against' }),
        param('pattern', patternType, { doc: 'a regex, or a string compiled as regex source' }),
        param('numeric_groups', boolType, { optional: true, namedOnly: true, defaultDoc: 'false' }),
      ],
      parseRegexReturnType,
      'always',
      true,
      'Matches `pattern` against `value` and returns its named capture groups as an object (each ' +
        'field a string; a group that did not participate in the match becomes ""). With ' +
        '`numeric_groups: true`, the whole match and every positional group are also included as ' +
        '`"0"`, `"1"`, ... fields. Fails if `value` does not match `pattern`, or if `pattern` is ' +
        'a string that is not a valid regex. When `pattern` is a constant regex or string ' +
        "literal, the checker infers the result's shape from its named capture groups.",
      [
        "let parsed = parse_regex(.message, r'^(?<ip>\\S+) \\S+ \\S+ \"(?<method>\\S+) (?<path>\\S+)') ?? abort",
        'parsed.ip',
      ],
    ),
  );
  impls?.register(
    impl('parse_regex', (args, ctx, span) => {
      const value = args.positional[0] ?? null;
      const pattern = args.positional[1] ?? null;
      if (typeof value !== 'string') {
        return new Failure(`parse_regex requires a string value, found ${scriptKindOf(value)}`);
      }
      const resolved = resolvePatternForMatch(pattern);
      if (!resolved.ok) return new Failure(`parse_regex: ${resolved.message}`);
      checkRegexInputLength(value.length, ctx.limits, span);
      resolved.regex.lastIndex = 0;
      const match = resolved.regex.exec(value);
      if (match === null) return new Failure('parse_regex: no match');
      const numericGroups = args.named.get('numeric_groups') === true;
      const out: ValueMap = new Map();
      if (match.groups !== undefined) {
        for (const [name, groupValue] of Object.entries(match.groups)) {
          out.set(name, groupValue ?? '');
        }
      }
      if (numericGroups) {
        for (let i = 0; i < match.length; i++) out.set(String(i), match[i] ?? '');
      }
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    }),
  );
}

// ---- compile_regex --------------------------------------------------------------------------

function registerCompileRegex(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'compile_regex',
      [
        param('pattern', stringType, { doc: 'the regex source text' }),
        param('flags', stringType, { optional: true, namedOnly: true, defaultDoc: '""' }),
      ],
      regexType,
      'always',
      true,
      'Compiles a string into a `regex` value, for passing to `parse_regex`/`parse_regex_all`/' +
        '`matches`/`replace`/`split` from a pattern built at run time. Fails if the pattern is ' +
        'not valid regex syntax.',
      ['compile_regex(.pattern, flags: "i")!'],
    ),
  );
  impls?.register(
    impl('compile_regex', (args) => {
      const pattern = args.positional[0] ?? null;
      if (typeof pattern !== 'string') {
        return new Failure(
          `compile_regex requires a string pattern, found ${scriptKindOf(pattern)}`,
        );
      }
      const flagsArg = args.named.get('flags');
      const flags = typeof flagsArg === 'string' ? flagsArg : '';
      const resolved = getCachedRegex(pattern, flags);
      if (!resolved.ok) return new Failure(`invalid regex: ${resolved.message}`);
      return new RegexValue(resolved.regex, pattern, flags);
    }),
  );
}

// ---- matches ------------------------------------------------------------------------------

function registerMatches(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'matches',
      [
        param('value', stringType, { doc: 'the text to test' }),
        param('pattern', patternType, { doc: 'a regex, or a string compiled as regex source' }),
      ],
      boolType,
      'always',
      true,
      'Returns true if `pattern` matches anywhere in `value`. Fails only if `pattern` is a ' +
        'string that is not a valid regex — unlike `contains`, which is a plain substring test, ' +
        'never a regex one. Named `matches` rather than `match`: `match` is a reserved keyword ' +
        "in Ferrule Script's own grammar (`match subject { ... }`) and cannot name a function.",
      ['if matches(.message, r/^ERROR/) { .level = "error" }'],
    ),
  );
  impls?.register(
    impl('matches', (args, ctx, span) => {
      const value = args.positional[0] ?? null;
      const pattern = args.positional[1] ?? null;
      if (typeof value !== 'string') {
        return new Failure(`matches requires a string value, found ${scriptKindOf(value)}`);
      }
      const resolved = resolvePatternForMatch(pattern);
      if (!resolved.ok) return new Failure(`matches: ${resolved.message}`);
      checkRegexInputLength(value.length, ctx.limits, span);
      resolved.regex.lastIndex = 0;
      return resolved.regex.test(value);
    }),
  );
}

// ---- parse_regex_all ------------------------------------------------------------------------

const matchType = objectType({
  match: stringType,
  groups: objectType({}, stringType),
});

function registerParseRegexAll(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_regex_all',
      [
        param('text', stringType, { doc: 'the text to search' }),
        param('pattern', patternType, {
          doc: 'a regex, or a string compiled as regex source, to match repeatedly',
        }),
      ],
      arrayType(matchType),
      'always',
      true,
      'Finds every non-overlapping match of `pattern` in `text`. Returns one object per match, ' +
        'each with a `"match"` field (the whole matched substring) and a `"groups"` field (an ' +
        "object of the pattern's named capture groups that matched; a group that did not " +
        'participate in the match is omitted). The match always runs with the `g` flag added, ' +
        'regardless of the flags `pattern` was compiled with. Fails if `pattern` is a string ' +
        'that is not a valid regex.',
      ['parse_regex_all(.line, compile_regex("(?<key>\\w+)=(?<val>\\w+)")!)!'],
    ),
  );
  impls?.register(
    impl('parse_regex_all', (args, ctx, span) => {
      const text = args.positional[0] ?? null;
      const pattern = args.positional[1] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_regex_all requires a string, found ${scriptKindOf(text)}`);
      }
      const resolved = resolvePatternForIteration(pattern);
      if (!resolved.ok) return new Failure(`parse_regex_all: ${resolved.message}`);
      checkRegexInputLength(text.length, ctx.limits, span);
      const out: Value[] = [];
      for (const match of text.matchAll(resolved.regex)) {
        const groups: ValueMap = new Map();
        if (match.groups !== undefined) {
          for (const [name, value] of Object.entries(match.groups)) {
            if (value !== undefined) groups.set(name, value);
          }
        }
        const entry: [string, Value][] = [
          ['match', match[0]],
          ['groups', groups],
        ];
        out.push(new Map(entry));
      }
      checkCollectionSize(out.length, ctx.limits, span);
      return out;
    }),
  );
}

// ---- parse_key_value -------------------------------------------------------------------------

function registerParseKeyValue(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_key_value',
      [
        param('text', stringType, { doc: 'the text to parse' }),
        param('field_separator', stringType, {
          optional: true,
          namedOnly: true,
          defaultDoc: '"="',
          doc: "separates a pair's key from its value",
        }),
        param('pair_separator', stringType, {
          optional: true,
          namedOnly: true,
          defaultDoc: '" "',
          doc: 'separates one pair from the next',
        }),
        param('quote', stringType, {
          optional: true,
          namedOnly: true,
          defaultDoc: '"\\""',
          doc: 'wraps a value that contains a separator',
        }),
      ],
      objectType({}, stringType),
      'always',
      true,
      'Parses `key=value` pairs, such as `level=info msg="hit rate limit" retries=3`, into an ' +
        'object. Splits `text` on `pair_separator` (default a single space) and each resulting ' +
        'pair on the first `field_separator` (default `"="`), treating a `pair_separator` or ' +
        '`field_separator` occurrence between a matching pair of `quote` characters (default ' +
        '`"`) as part of the value rather than a split point. Leading and trailing whitespace is ' +
        "trimmed from keys and values, and a value's surrounding `quote` characters (when both " +
        'are present) are stripped. Runs of separators produce empty segments, which are ' +
        'ignored. Fails if a pair has no `field_separator`. This is a "reasonable subset" ' +
        'parser: it does not support escaping a `quote` character inside a quoted value (there ' +
        'is no way to include a literal `quote` in a value), and keys themselves cannot be quoted.',
      [
        'parse_key_value(.line)!',
        'parse_key_value(.line, field_separator: ":", pair_separator: ",")!',
      ],
    ),
  );
  impls?.register(
    impl('parse_key_value', (args, ctx, span) => {
      const text = args.positional[0] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_key_value requires a string, found ${scriptKindOf(text)}`);
      }
      const fieldSeparator = stringNamed(args, 'field_separator', '=');
      const pairSeparator = stringNamed(args, 'pair_separator', ' ');
      const quote = stringNamed(args, 'quote', '"');
      const result = parseKeyValueText(text, fieldSeparator, pairSeparator, quote);
      if (result instanceof Failure) return result;
      checkCollectionSize(result.size, ctx.limits, span);
      return result;
    }),
  );
}

function stringNamed(args: CallArgs, name: string, fallback: string): string {
  const v = args.named.get(name);
  return typeof v === 'string' ? v : fallback;
}

/**
 * Splits `str` on `sep`, treating any run of characters between a matching pair of `quote`
 * occurrences as unsplittable, and stops splitting once `maxParts` segments have been started
 * (so `maxParts: 2` splits only on the first unquoted occurrence of `sep`). Quoting has no
 * escape mechanism: a `quote` occurrence always toggles "inside a quote", even inside a
 * would-be-split value.
 */
function scanSplit(str: string, sep: string, quote: string, maxParts: number): string[] {
  if (sep.length === 0) return [str];
  const parts: string[] = [];
  let start = 0;
  let inQuote = false;
  let i = 0;
  while (i < str.length) {
    if (quote.length > 0 && str.startsWith(quote, i)) {
      inQuote = !inQuote;
      i += quote.length;
      continue;
    }
    if (!inQuote && parts.length < maxParts - 1 && str.startsWith(sep, i)) {
      parts.push(str.slice(start, i));
      i += sep.length;
      start = i;
      continue;
    }
    i++;
  }
  parts.push(str.slice(start));
  return parts;
}

function parseKeyValueText(
  text: string,
  fieldSeparator: string,
  pairSeparator: string,
  quote: string,
): ValueMap | Failure {
  const out: ValueMap = new Map();
  for (const rawPair of scanSplit(text, pairSeparator, quote, Number.POSITIVE_INFINITY)) {
    const pair = rawPair.trim();
    if (pair.length === 0) continue;
    const parts = scanSplit(pair, fieldSeparator, quote, 2);
    if (parts.length < 2) {
      return new Failure(
        `parse_key_value: pair ${JSON.stringify(pair)} has no field separator ${JSON.stringify(fieldSeparator)}`,
      );
    }
    const key = parts[0]!.trim();
    let value = parts[1]!.trim();
    if (
      quote.length > 0 &&
      value.length >= quote.length * 2 &&
      value.startsWith(quote) &&
      value.endsWith(quote)
    ) {
      value = value.slice(quote.length, value.length - quote.length);
    }
    out.set(key, value);
  }
  return out;
}

// ---- parse_int --------------------------------------------------------------------------------

function registerParseInt(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_int',
      [
        param('text', stringType, { doc: 'the text to parse' }),
        param('radix', intType, { optional: true, namedOnly: true, defaultDoc: '10' }),
      ],
      intType,
      'always',
      true,
      'Parses a string as an integer in the given `radix` (2-36, default 10). Accepts an ' +
        'optional leading `+` or `-`, and rejects digits outside the radix. Unlike `to_int`, ' +
        'which only parses base-10 text, this supports arbitrary radixes. Fails if the text is ' +
        'not a full match (no partial parses) or the value does not fit in an int64.',
      ['parse_int("ff", radix: 16)!', 'parse_int("-101", radix: 2)!'],
    ),
  );
  impls?.register(
    impl('parse_int', (args) => {
      const text = args.positional[0] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_int requires a string, found ${scriptKindOf(text)}`);
      }
      const radixArg = args.named.get('radix');
      const radix = typeof radixArg === 'bigint' ? Number(radixArg) : 10;
      if (!Number.isInteger(radix) || radix < 2 || radix > 36) {
        return new Failure(`parse_int radix must be an integer between 2 and 36, found ${radix}`);
      }
      const trimmed = text.trim();
      const m = /^([+-]?)([0-9a-zA-Z]+)$/.exec(trimmed);
      if (m === null) {
        return new Failure(`cannot parse ${JSON.stringify(text)} as a base-${radix} int`);
      }
      const sign = m[1]!;
      const digits = m[2]!;
      const bigRadix = BigInt(radix);
      let value = 0n;
      for (const ch of digits) {
        const d = digitValue(ch);
        if (d === undefined || d >= radix) {
          return new Failure(`cannot parse ${JSON.stringify(text)} as a base-${radix} int`);
        }
        value = value * bigRadix + BigInt(d);
      }
      if (sign === '-') value = -value;
      if (!isInt64(value)) return new Failure(`${trimmed} is out of int64 range`);
      return value;
    }),
  );
}

function digitValue(ch: string): number | undefined {
  const code = ch.toLowerCase().charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // '0'-'9'
  if (code >= 97 && code <= 122) return code - 97 + 10; // 'a'-'z'
  return undefined;
}

// ---- parse_float --------------------------------------------------------------------------------

const FLOAT_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function registerParseFloat(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_float',
      [param('text', stringType, { doc: 'the text to parse' })],
      floatType,
      'always',
      true,
      'Parses a string as a float: an optional sign, digits, an optional decimal point, and an ' +
        'optional exponent (`"1"`, `"-3.5"`, `"2.5e10"`). Fails unless the whole string is a ' +
        "valid float literal — unlike JavaScript's lenient `parseFloat`, trailing garbage is " +
        'not tolerated.',
      ['parse_float("3.14")!', 'parse_float(.raw_latency)!'],
    ),
  );
  impls?.register(
    impl('parse_float', (args) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`parse_float requires a string, found ${scriptKindOf(v)}`);
      }
      const trimmed = v.trim();
      if (!FLOAT_LITERAL.test(trimmed)) {
        return new Failure(`cannot parse ${JSON.stringify(v)} as a float`);
      }
      const n = Number(trimmed);
      if (Number.isNaN(n)) return new Failure(`cannot parse ${JSON.stringify(v)} as a float`);
      return n;
    }),
  );
}

// ---- parse_timestamp ------------------------------------------------------------------------

function registerParseTimestamp(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_timestamp',
      [
        param('text', stringType, { doc: 'the text to parse' }),
        param('format', stringType, {
          optional: true,
          namedOnly: true,
          doc: 'a strftime-style pattern; if omitted, `text` is parsed as RFC 3339',
        }),
      ],
      timestampType,
      'always',
      true,
      'Parses a string as a timestamp. With `format` given, parses `text` against a ' +
        'strftime-style pattern (see `format_timestamp`), supporting only its numeric ' +
        'directives (`%Y %y %m %d %H %M %S %L %f %z`); without `format`, parses `text` as RFC ' +
        '3339. Fails if `text` does not match.',
      ['parse_timestamp(.ts)!', 'parse_timestamp(.ts, format: "%Y-%m-%d %H:%M:%S")!'],
    ),
  );
  impls?.register(
    impl('parse_timestamp', (args) => {
      const text = args.positional[0] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_timestamp requires a string, found ${scriptKindOf(text)}`);
      }
      const formatArg = args.named.get('format');
      if (typeof formatArg === 'string') {
        const result = parseStrftime(text, formatArg);
        return (
          result ??
          new Failure(
            `cannot parse ${JSON.stringify(text)} as a timestamp with format ${JSON.stringify(formatArg)}`,
          )
        );
      }
      const result = Timestamp.tryParse(text);
      return result ?? new Failure(`cannot parse ${JSON.stringify(text)} as an RFC 3339 timestamp`);
    }),
  );
}

// ---- parse_duration -------------------------------------------------------------------------

function registerParseDuration(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_duration',
      [param('text', stringType, { doc: 'the duration text to parse' })],
      intType,
      'always',
      true,
      'Parses a human-friendly duration string, such as `"250ms"`, `"1h30m"`, or `"1.5s"`, and ' +
        'returns its length in nanoseconds as an int. Fails if the text is not a valid ' +
        'duration, or if the result does not fit in an int64.',
      ['parse_duration("1h30m")!', 'parse_duration(.raw_timeout)!'],
    ),
  );
  impls?.register(
    impl('parse_duration', (args) => {
      const text = args.positional[0] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_duration requires a string, found ${scriptKindOf(text)}`);
      }
      let nanos: bigint;
      try {
        nanos = parseDuration(text);
      } catch (error) {
        return new Failure(
          `invalid duration ${JSON.stringify(text)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isInt64(nanos)) {
        return new Failure(`duration ${JSON.stringify(text)} (${nanos}ns) is out of int64 range`);
      }
      return nanos;
    }),
  );
}

// ---- parse_url ------------------------------------------------------------------------------

const urlType = objectType({
  scheme: stringType,
  host: stringType,
  port: unionType([intType, nullType]),
  path: stringType,
  query: stringType,
  fragment: stringType,
  username: stringType,
  password: stringType,
});

function registerParseUrl(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_url',
      [param('text', stringType, { doc: 'the URL to parse' })],
      urlType,
      'always',
      true,
      'Parses a URL into its components: `"scheme"` (without the trailing `:`), `"host"`, ' +
        '`"port"` (int, or `null` if not given explicitly), `"path"`, `"query"` (the raw query ' +
        'string, without the leading `?`), `"fragment"` (without the leading `#`), ' +
        '`"username"`, and `"password"`. `"username"`/`"password"` are empty strings when ' +
        'absent, matching the underlying `URL` behaviour. Fails if `text` is not a valid URL.',
      ['parse_url(.request_url)!', 'parse_url("https://user:pass@example.com:8443/a/b?x=1#frag")!'],
    ),
  );
  impls?.register(
    impl('parse_url', (args) => {
      const text = args.positional[0] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_url requires a string, found ${scriptKindOf(text)}`);
      }
      let url: URL;
      try {
        url = new URL(text);
      } catch (error) {
        return new Failure(
          `invalid URL ${JSON.stringify(text)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const scheme = url.protocol.endsWith(':') ? url.protocol.slice(0, -1) : url.protocol;
      const port = url.port === '' ? null : BigInt(url.port);
      const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
      const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
      const entries: [string, Value][] = [
        ['scheme', scheme],
        ['host', url.hostname],
        ['port', port],
        ['path', url.pathname],
        ['query', query],
        ['fragment', fragment],
        ['username', url.username],
        ['password', url.password],
      ];
      return new Map(entries);
    }),
  );
}

// ---- parse_query_string ---------------------------------------------------------------------

function registerParseQueryString(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
): void {
  registry.register(
    fn(
      'parse_query_string',
      [
        param('text', stringType, {
          doc: 'the query string to parse, with or without a leading "?"',
        }),
      ],
      objectType({}, unionType([stringType, arrayType(stringType)])),
      'always',
      true,
      'Parses a query string (a leading `?`, if present, is stripped) into an object mapping ' +
        'each key to its value. Keys and values are percent-decoded. A key that appears only ' +
        'once maps to a plain string; a key that repeats is promoted to an array of strings, in ' +
        'the order encountered (the first occurrence becomes a string, and each further ' +
        'occurrence of the same key appends to it, converting it to an array on the second one).',
      ['parse_query_string(.raw_query)!', 'parse_query_string("a=1&a=2&b=3")!'],
    ),
  );
  impls?.register(
    impl('parse_query_string', (args, ctx, span) => {
      const text = args.positional[0] ?? null;
      if (typeof text !== 'string') {
        return new Failure(`parse_query_string requires a string, found ${scriptKindOf(text)}`);
      }
      const stripped = text.startsWith('?') ? text.slice(1) : text;
      const params = new URLSearchParams(stripped);
      const out: ValueMap = new Map();
      for (const [key, value] of params) {
        const existing = out.get(key);
        if (existing === undefined) {
          out.set(key, value);
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else if (typeof existing === 'string') {
          out.set(key, [existing, value]);
        }
      }
      checkCollectionSize(out.size, ctx.limits, span);
      return out;
    }),
  );
}
