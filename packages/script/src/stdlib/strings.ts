import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import type { RuntimeValue } from '../runtime/context.js';
import { toDisplayString } from '../runtime/display.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import {
  checkCollectionSize,
  checkRegexInputLength,
  checkStringLength,
} from '../runtime/limits.js';
import { isRegexValue } from '../runtime/regex.js';
import {
  anyType,
  arrayType,
  boolType,
  intType,
  regexType,
  stringType,
  unionType,
} from '../types/types.js';
import { fn } from './helpers.js';

const patternType = unionType([stringType, regexType]);
const stringArrayType = arrayType(stringType);
const anyArrayTypeForFormat = arrayType(anyType);

/**
 * Strings: `trim`/`trim_start`/`trim_end`, `contains`, `starts_with`, `ends_with`, `replace`,
 * `split`, `join`, `slice`, `pad_start`/`pad_end`, `truncate`, `strip_ansi`, `format`, `repeat`.
 * `upcase`/`downcase`/`length` are implemented in `stdlib/core.ts` (their signatures predate this
 * module, in `registry/builtins.ts`).
 */
export function registerStrings(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerTrimFamily(registry, impls);
  registerContainmentFamily(registry, impls);
  registerReplace(registry, impls);
  registerSplit(registry, impls);
  registerJoin(registry, impls);
  registerSlice(registry, impls);
  registerPadFamily(registry, impls);
  registerTruncate(registry, impls);
  registerStripAnsi(registry, impls);
  registerFormat(registry, impls);
  registerRepeat(registry, impls);
}

// ---- trim / trim_start / trim_end -----------------------------------------------------------

function registerTrimFamily(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerTrimOne(registry, impls, 'trim', 'both ends', (s) => s.trim());
  registerTrimOne(registry, impls, 'trim_start', 'the start', (s) => s.trimStart());
  registerTrimOne(registry, impls, 'trim_end', 'the end', (s) => s.trimEnd());
}

function registerTrimOne(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
  name: string,
  where: string,
  trim: (s: string) => string,
): void {
  registry.register(
    fn(
      name,
      [param('value', stringType, { doc: 'the string to trim' })],
      stringType,
      'on-argument-mismatch',
      true,
      `Trims Unicode whitespace from ${where} of a string.`,
      [`${name}(.line)`],
    ),
  );
  impls?.register(
    impl(name, (args) => {
      const v = args.positional[0] ?? null;
      return typeof v === 'string'
        ? trim(v)
        : new Failure(`${name} requires a string, found ${scriptKindOf(v)}`);
    }),
  );
}

// ---- contains / starts_with / ends_with ------------------------------------------------------

function registerContainmentFamily(
  registry: FunctionRegistry,
  impls?: ImplementationRegistry,
): void {
  registerContainmentOne(
    registry,
    impls,
    'contains',
    'substring',
    'Returns true if `value` contains `substring`.',
    (v, s) => v.includes(s),
    ['contains(.message, "timeout")'],
  );
  registerContainmentOne(
    registry,
    impls,
    'starts_with',
    'prefix',
    'Returns true if `value` starts with `prefix`.',
    (v, s) => v.startsWith(s),
    ['starts_with(.path, "/api/")'],
  );
  registerContainmentOne(
    registry,
    impls,
    'ends_with',
    'suffix',
    'Returns true if `value` ends with `suffix`.',
    (v, s) => v.endsWith(s),
    ['ends_with(.filename, ".json")'],
  );
}

function registerContainmentOne(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
  name: string,
  secondParamName: string,
  docs: string,
  check: (value: string, other: string) => boolean,
  examples: readonly string[],
): void {
  registry.register(
    fn(
      name,
      [param('value', stringType), param(secondParamName, stringType)],
      boolType,
      'on-argument-mismatch',
      true,
      docs,
      examples,
    ),
  );
  impls?.register(
    impl(name, (args) => {
      const v = args.positional[0] ?? null;
      const other = args.positional[1] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`${name} requires a string, found ${scriptKindOf(v)}`);
      }
      if (typeof other !== 'string') {
        return new Failure(
          `${name} requires a string ${secondParamName}, found ${scriptKindOf(other)}`,
        );
      }
      return check(v, other);
    }),
  );
}

// ---- replace -----------------------------------------------------------------------------------

function registerReplace(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'replace',
      [
        param('value', stringType, { doc: 'the string to search' }),
        param('pattern', patternType, { doc: 'a literal string or a regex to match' }),
        param('replacement', stringType, {
          doc: 'inserted literally at each match; no `$1`-style substitution',
        }),
        param('count', intType, { optional: true, namedOnly: true, defaultDoc: 'unlimited' }),
      ],
      stringType,
      'on-argument-mismatch',
      true,
      'Replaces occurrences of `pattern` (a literal string, or a regex) in `value` with ' +
        '`replacement`. By default every occurrence is replaced; pass `count` to replace only the ' +
        'first `count` occurrences, left to right. `replacement` is always inserted literally.',
      ['replace(.message, "secret", "***")', 'replace(.line, /\\d+/, "#", count: 1)'],
    ),
  );
  impls?.register(
    impl('replace', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const pattern = args.positional[1] ?? null;
      const replacement = args.positional[2] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`replace requires a string, found ${scriptKindOf(v)}`);
      }
      if (typeof replacement !== 'string') {
        return new Failure(
          `replace requires a string replacement, found ${scriptKindOf(replacement)}`,
        );
      }
      const countArg = args.named.get('count');
      if (countArg !== undefined && typeof countArg !== 'bigint') {
        return new Failure(`replace requires an int count, found ${scriptKindOf(countArg)}`);
      }
      const limit = countArg === undefined ? Number.POSITIVE_INFINITY : Number(countArg);

      let result: string;
      if (typeof pattern === 'string') {
        result = replaceLiteral(v, pattern, replacement, limit);
      } else if (isRegexValue(pattern)) {
        checkRegexInputLength(v.length, ctx.limits, span);
        result = replaceRegex(v, pattern.regex, replacement, limit);
      } else {
        return new Failure(
          `replace requires a string or regex pattern, found ${scriptKindOf(pattern)}`,
        );
      }
      checkStringLength(result.length, ctx.limits, span);
      return result;
    }),
  );
}

function replaceLiteral(
  value: string,
  pattern: string,
  replacement: string,
  limit: number,
): string {
  if (limit <= 0) return value;
  if (pattern.length === 0) {
    let out = '';
    let count = 0;
    for (let i = 0; i <= value.length; i++) {
      if (count < limit) {
        out += replacement;
        count++;
      }
      if (i < value.length) out += value[i];
    }
    return out;
  }
  let out = '';
  let rest = value;
  let count = 0;
  while (count < limit) {
    const idx = rest.indexOf(pattern);
    if (idx === -1) break;
    out += rest.slice(0, idx) + replacement;
    rest = rest.slice(idx + pattern.length);
    count++;
  }
  return out + rest;
}

function replaceRegex(value: string, regex: RegExp, replacement: string, limit: number): string {
  if (limit <= 0) return value;
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let out = '';
  let lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while (count < limit && (match = re.exec(value)) !== null) {
    out += value.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) {
      if (re.lastIndex >= value.length) {
        count++;
        break;
      }
      re.lastIndex++;
    }
    count++;
  }
  return out + value.slice(lastIndex);
}

// ---- split -------------------------------------------------------------------------------------

function registerSplit(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'split',
      [
        param('value', stringType, { doc: 'the string to split' }),
        param('separator', patternType, { doc: 'a literal string or a regex to split on' }),
        param('limit', intType, { optional: true, namedOnly: true, defaultDoc: 'unlimited' }),
      ],
      stringArrayType,
      'on-argument-mismatch',
      true,
      'Splits `value` on every occurrence of `separator` (a literal string, or a regex) into an ' +
        'array of substrings. If `limit` is given, splits at most `limit - 1` times, so the result ' +
        'has at most `limit` elements and the last element contains the unsplit remainder of the string.',
      ['split(.path, "/")', 'split(.csv, /,\\s*/, limit: 3)'],
    ),
  );
  impls?.register(
    impl('split', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const separator = args.positional[1] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`split requires a string, found ${scriptKindOf(v)}`);
      }
      const limitArg = args.named.get('limit');
      if (limitArg !== undefined && typeof limitArg !== 'bigint') {
        return new Failure(`split requires an int limit, found ${scriptKindOf(limitArg)}`);
      }
      const limit = limitArg === undefined ? Number.POSITIVE_INFINITY : Number(limitArg);

      let parts: string[];
      if (typeof separator === 'string') {
        parts = splitLiteral(v, separator, limit);
      } else if (isRegexValue(separator)) {
        checkRegexInputLength(v.length, ctx.limits, span);
        parts = splitRegex(v, separator.regex, limit);
      } else {
        return new Failure(
          `split requires a string or regex separator, found ${scriptKindOf(separator)}`,
        );
      }
      checkCollectionSize(parts.length, ctx.limits, span);
      return parts;
    }),
  );
}

function splitLiteral(value: string, sep: string, limit: number): string[] {
  if (limit <= 0) return [];
  if (sep.length === 0) {
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (out.length === limit - 1) {
        out.push(value.slice(i));
        return out;
      }
      out.push(value[i]!);
    }
    return out;
  }
  const out: string[] = [];
  let rest = value;
  while (out.length < limit - 1) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

function splitRegex(value: string, regex: RegExp, limit: number): string[] {
  if (limit <= 0) return [];
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while (out.length < limit - 1 && (match = re.exec(value)) !== null) {
    if (match[0].length === 0) {
      if (re.lastIndex >= value.length) break;
      re.lastIndex++;
      continue;
    }
    out.push(value.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
  }
  out.push(value.slice(lastIndex));
  return out;
}

// ---- join --------------------------------------------------------------------------------------

function registerJoin(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'join',
      [
        param('value', stringArrayType, { doc: 'the strings to join' }),
        param('separator', stringType, { doc: 'inserted between each element' }),
      ],
      stringType,
      'on-argument-mismatch',
      true,
      'Joins an array of strings into one string, with `separator` between each element.',
      ['join(.tags, ", ")'],
    ),
  );
  impls?.register(
    impl('join', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const separator = args.positional[1] ?? null;
      if (!Array.isArray(v)) return new Failure(`join requires an array, found ${scriptKindOf(v)}`);
      if (typeof separator !== 'string') {
        return new Failure(`join requires a string separator, found ${scriptKindOf(separator)}`);
      }
      const parts: string[] = [];
      for (const el of v) {
        if (typeof el !== 'string') {
          return new Failure(`join requires an array of strings, found ${scriptKindOf(el)}`);
        }
        parts.push(el);
      }
      const result = parts.join(separator);
      checkStringLength(result.length, ctx.limits, span);
      return result;
    }),
  );
}

// ---- slice ---------------------------------------------------------------------------------------

function registerSlice(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'slice',
      [
        param('value', stringType),
        param('start', intType, { doc: 'a negative value counts from the end' }),
        param('end', intType, {
          optional: true,
          namedOnly: true,
          defaultDoc: 'the end of the string',
        }),
      ],
      stringType,
      'on-argument-mismatch',
      true,
      'Returns a substring from `start` up to (but not including) `end`, counted in UTF-16 code ' +
        "units. Negative indices count from the end of the string, matching JavaScript's `slice`. " +
        'Out-of-range indices are clamped rather than failing.',
      ['slice(.message, 0, end: 100)', 'slice(.name, -3)'],
    ),
  );
  impls?.register(
    impl('slice', (args) => {
      const v = args.positional[0] ?? null;
      const start = args.positional[1] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`slice requires a string, found ${scriptKindOf(v)}`);
      }
      if (typeof start !== 'bigint') {
        return new Failure(`slice requires an int start, found ${scriptKindOf(start)}`);
      }
      const endArg = args.named.get('end');
      if (endArg !== undefined && typeof endArg !== 'bigint') {
        return new Failure(`slice requires an int end, found ${scriptKindOf(endArg)}`);
      }
      return v.slice(Number(start), endArg === undefined ? undefined : Number(endArg));
    }),
  );
}

// ---- pad_start / pad_end -------------------------------------------------------------------------

function registerPadFamily(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registerPadOne(registry, impls, 'pad_start', 'the start', (s, width, pad) =>
    s.padStart(width, pad),
  );
  registerPadOne(registry, impls, 'pad_end', 'the end', (s, width, pad) => s.padEnd(width, pad));
}

function registerPadOne(
  registry: FunctionRegistry,
  impls: ImplementationRegistry | undefined,
  name: string,
  where: string,
  pad: (value: string, width: number, padding: string) => string,
): void {
  registry.register(
    fn(
      name,
      [
        param('value', stringType),
        param('width', intType, { doc: 'the target length, in UTF-16 code units' }),
        param('pad', stringType, { optional: true, namedOnly: true, defaultDoc: '" "' }),
      ],
      stringType,
      'on-argument-mismatch',
      true,
      `Pads \`value\` at ${where} with \`pad\` (repeated as needed) until it reaches \`width\` code ` +
        'units. If `value` is already at least `width` long, it is returned unchanged.',
      [`${name}(to_string(.id), 6, pad: "0")`],
    ),
  );
  impls?.register(
    impl(name, (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const width = args.positional[1] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`${name} requires a string, found ${scriptKindOf(v)}`);
      }
      if (typeof width !== 'bigint') {
        return new Failure(`${name} requires an int width, found ${scriptKindOf(width)}`);
      }
      const padArg = args.named.get('pad');
      if (padArg !== undefined && typeof padArg !== 'string') {
        return new Failure(`${name} requires a string pad, found ${scriptKindOf(padArg)}`);
      }
      const result = pad(v, Number(width), padArg ?? ' ');
      checkStringLength(result.length, ctx.limits, span);
      return result;
    }),
  );
}

// ---- truncate --------------------------------------------------------------------------------

function registerTruncate(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'truncate',
      [
        param('value', stringType),
        param('length', intType, { doc: 'the maximum length of the result, including `suffix`' }),
        param('suffix', stringType, { optional: true, namedOnly: true, defaultDoc: '"..."' }),
      ],
      stringType,
      'on-argument-mismatch',
      true,
      'Truncates `value` to at most `length` UTF-16 code units, appending `suffix` when it does. ' +
        'The result (including `suffix`) never exceeds `length` code units; if `value` already fits, ' +
        'it is returned unchanged. `length <= 0` returns an empty string.',
      ['truncate(.message, 80)', 'truncate(.message, 20, suffix: "…")'],
    ),
  );
  impls?.register(
    impl('truncate', (args) => {
      const v = args.positional[0] ?? null;
      const length = args.positional[1] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`truncate requires a string, found ${scriptKindOf(v)}`);
      }
      if (typeof length !== 'bigint') {
        return new Failure(`truncate requires an int length, found ${scriptKindOf(length)}`);
      }
      const suffixArg = args.named.get('suffix');
      if (suffixArg !== undefined && typeof suffixArg !== 'string') {
        return new Failure(`truncate requires a string suffix, found ${scriptKindOf(suffixArg)}`);
      }
      return truncateString(v, Number(length), suffixArg ?? '...');
    }),
  );
}

function truncateString(value: string, length: number, suffix: string): string {
  if (value.length <= length) return value;
  if (length <= 0) return '';
  const budget = Math.max(0, length - suffix.length);
  const result = value.slice(0, budget) + suffix;
  return result.length > length ? result.slice(0, length) : result;
}

// ---- strip_ansi ------------------------------------------------------------------------------

// A well-known pattern for ANSI/CSI escape sequences (SGR color codes and the broader CSI form).
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- matching control characters is the whole point
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]))/g;

function registerStripAnsi(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'strip_ansi',
      [param('value', stringType)],
      stringType,
      'on-argument-mismatch',
      true,
      'Removes ANSI escape sequences (SGR color codes and other CSI sequences) from a string.',
      ['strip_ansi(.log_line)'],
    ),
  );
  impls?.register(
    impl('strip_ansi', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`strip_ansi requires a string, found ${scriptKindOf(v)}`);
      }
      checkRegexInputLength(v.length, ctx.limits, span);
      ANSI_PATTERN.lastIndex = 0;
      return v.replace(ANSI_PATTERN, '');
    }),
  );
}

// ---- format ------------------------------------------------------------------------------------

function registerFormat(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'format',
      [
        param('template', stringType, { doc: 'a string with `{}`/`{0}`/`{1}`/... placeholders' }),
        param('args', anyArrayTypeForFormat, { doc: 'values substituted into the placeholders' }),
      ],
      stringType,
      'always',
      true,
      'Substitutes `{}` or `{N}` placeholders in `template` with the elements of `args`, rendered ' +
        'the same way string interpolation renders a value. A bare `{}` consumes the next unused ' +
        'element of `args`, left to right; `{N}` refers to `args[N]` explicitly regardless of ' +
        'ordering, and does not itself advance the bare-placeholder cursor. Fails if a placeholder ' +
        'index is out of range for `args`, or if `template` has an unmatched `{` or `}`.',
      [
        'format("{} responded with {}", [.service, .status])!',
        'format("{1} before {0}", [.b, .a])!',
      ],
    ),
  );
  impls?.register(
    impl('format', (args, ctx, span) => {
      const template = args.positional[0] ?? null;
      const list = args.positional[1] ?? null;
      if (typeof template !== 'string') {
        return new Failure(`format requires a string template, found ${scriptKindOf(template)}`);
      }
      if (!Array.isArray(list)) {
        return new Failure(`format requires an array of args, found ${scriptKindOf(list)}`);
      }
      const result = formatTemplate(template, list);
      if (result instanceof Failure) return result;
      checkStringLength(result.length, ctx.limits, span);
      return result;
    }),
  );
}

function formatTemplate(template: string, args: readonly RuntimeValue[]): string | Failure {
  let out = '';
  let autoIndex = 0;
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === '{') {
      const close = template.indexOf('}', i + 1);
      if (close === -1) return new Failure(`format: unmatched '{' at position ${i}`);
      const spec = template.slice(i + 1, close);
      let index: number;
      if (spec === '') {
        index = autoIndex++;
      } else if (/^\d+$/.test(spec)) {
        index = Number(spec);
      } else {
        return new Failure(`format: invalid placeholder "{${spec}}" at position ${i}`);
      }
      const arg = args[index];
      if (index >= args.length) {
        return new Failure(
          `format: placeholder index ${index} is out of range for ${args.length} argument(s)`,
        );
      }
      out += toDisplayString(arg ?? null);
      i = close + 1;
    } else if (ch === '}') {
      return new Failure(`format: unmatched '}' at position ${i}`);
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// ---- repeat --------------------------------------------------------------------------------------

function registerRepeat(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'repeat',
      [
        param('value', stringType),
        param('count', intType, { doc: 'how many times to repeat `value`' }),
      ],
      stringType,
      'always',
      true,
      'Repeats `value` `count` times. Fails if `count` is negative.',
      ['repeat("=", 40)!', 'repeat(.indent, .depth)!'],
    ),
  );
  impls?.register(
    impl('repeat', (args, ctx, span) => {
      const v = args.positional[0] ?? null;
      const count = args.positional[1] ?? null;
      if (typeof v !== 'string') {
        return new Failure(`repeat requires a string, found ${scriptKindOf(v)}`);
      }
      if (typeof count !== 'bigint') {
        return new Failure(`repeat requires an int count, found ${scriptKindOf(count)}`);
      }
      if (count < 0n) return new Failure(`repeat requires a non-negative count, found ${count}`);
      if (v.length === 0 || count === 0n) return '';
      const expectedLength =
        count > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(v.length) * Number(count);
      checkStringLength(expectedLength, ctx.limits, span);
      return v.repeat(Number(count));
    }),
  );
}
