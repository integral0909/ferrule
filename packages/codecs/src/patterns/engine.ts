import {
  createMetadata,
  LimitExceededError,
  LogEvent,
  Timestamp,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { CodecSyntaxError, PatternNoMatchError } from '../errors.js';

const CODEC = 'pattern';

/** How a named capture's text is converted to a {@link Value}. */
export type CaptureType = 'string' | 'int' | 'float' | 'timestamp';

export interface PatternCompileOptions {
  /** Require the whole input to match (`^(?:...)$`) rather than a substring search. Default `true`. */
  anchored?: boolean;
  /** Case-insensitive matching. Default `false`. */
  caseInsensitive?: boolean;
  /** Maximum pattern-references-pattern recursion depth. Default 32. */
  maxDepth?: number;
  /** Maximum input length {@link CompiledPattern.match}/`test` will attempt to match. Default 1 MiB. */
  maxInputLength?: number;
}

interface CaptureInfo {
  internalName: string;
  fieldName: string;
  type: CaptureType;
}

/** A pattern compiled once to a `RegExp`, ready to match many inputs. */
export interface CompiledPattern {
  /** The expanded regular expression source, useful for debugging. */
  readonly source: string;
  readonly regex: RegExp;
  /** Matches `text`, returning captured fields as a {@link ValueMap}, or `undefined` if it does
   * not match. Throws {@link CodecSyntaxError} if a typed capture's text cannot convert to its
   * declared type (e.g. `:int` capturing non-digits). */
  match(text: string): ValueMap | undefined;
  test(text: string): boolean;
  /** Matches `text` and builds a {@link LogEvent} from the captures, or throws
   * {@link PatternNoMatchError} if it does not match. */
  decode(text: string): LogEvent;
}

function fail(message: string): never {
  throw new CodecSyntaxError(CODEC, 'E_PATTERN_SYNTAX', message);
}

const REF_SOURCE = String.raw`%\{([A-Za-z_][A-Za-z0-9_]*)(?::([^:}]+))?(?::(string|int|float|timestamp))?\}`;
const DEFAULT_MAX_INPUT_LENGTH = 1024 * 1024;

/**
 * A registry of named, composable pattern fragments — grok-style, but with an original syntax and
 * an independent implementation. A pattern is a mix of literal regular expression syntax and
 * `%{NAME}` references to other registered patterns:
 *
 * - `%{NAME}` inserts the named pattern's expansion as a non-capturing group.
 * - `%{NAME:field}` additionally captures the match under `field` (a string, by default).
 * - `%{NAME:field:type}` captures and converts to `type` (`int`, `float`, or `timestamp`, which
 *   parses as RFC 3339).
 *
 * Patterns are compiled to a single `RegExp` once, up front; matching an input never recompiles.
 * Each registry is independent (define your own fragments, or start from {@link builtinPatterns}).
 */
export class PatternRegistry {
  private readonly patterns = new Map<string, string>();

  constructor(base?: PatternRegistry) {
    if (base !== undefined) for (const [k, v] of base.patterns) this.patterns.set(k, v);
  }

  /** Defines (or overrides) a named pattern fragment. */
  define(name: string, pattern: string): this {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`invalid pattern name ${JSON.stringify(name)}`);
    }
    this.patterns.set(name, pattern);
    return this;
  }

  has(name: string): boolean {
    return this.patterns.has(name);
  }

  get(name: string): string | undefined {
    return this.patterns.get(name);
  }

  /** Compiles a pattern string into a reusable {@link CompiledPattern}. */
  compile(pattern: string, options: PatternCompileOptions = {}): CompiledPattern {
    const maxDepth = options.maxDepth ?? 32;
    const maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
    const captures: CaptureInfo[] = [];
    let counter = 0;

    const expand = (text: string, depth: number, path: readonly string[]): string => {
      if (depth > maxDepth) {
        throw new LimitExceededError(
          'pattern.depth',
          maxDepth,
          'pattern reference nesting too deep',
        );
      }
      let out = '';
      let last = 0;
      // A fresh regex instance per call: `expand` recurses (to expand a referenced pattern's own
      // body) before this loop finishes, and a shared, module-level `RegExp` would have its
      // mutable `lastIndex` clobbered by that inner call, corrupting the outer loop's position
      // and — since `text.slice(last, m.index)` could then see `last` jump backwards — potentially
      // re-matching the same reference forever.
      const ref = new RegExp(REF_SOURCE, 'g');
      let m: RegExpExecArray | null;
      while ((m = ref.exec(text)) !== null) {
        out += text.slice(last, m.index);
        const refName = m[1]!;
        const fieldName = m[2];
        const type = m[3] as CaptureType | undefined;
        if (path.includes(refName)) fail(`cyclic pattern reference through %{${refName}}`);
        const body = this.patterns.get(refName);
        if (body === undefined) fail(`unknown pattern %{${refName}}`);
        const expandedBody = expand(body, depth + 1, [...path, refName]);
        if (fieldName !== undefined) {
          const internalName = `c${counter++}`;
          captures.push({ internalName, fieldName, type: type ?? 'string' });
          out += `(?<${internalName}>${expandedBody})`;
        } else {
          out += `(?:${expandedBody})`;
        }
        last = ref.lastIndex;
      }
      out += text.slice(last);
      return out;
    };

    let source = expand(pattern, 0, []);
    checkBacktrackingRisk(source);
    if (options.anchored ?? true) source = `^(?:${source})$`;

    let regex: RegExp;
    try {
      regex = new RegExp(source, options.caseInsensitive ? 'iu' : 'u');
    } catch (cause) {
      fail(`failed to compile pattern: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    const match = (text: string): ValueMap | undefined => {
      if (text.length > maxInputLength) {
        throw new LimitExceededError('pattern.input.length', maxInputLength);
      }
      return matchWith(regex, captures, text);
    };

    const test = (text: string): boolean => {
      if (text.length > maxInputLength) {
        throw new LimitExceededError('pattern.input.length', maxInputLength);
      }
      return regex.test(text);
    };

    return {
      source,
      regex,
      match,
      test,
      decode: (text: string) => {
        const fields = match(text);
        if (fields === undefined) throw new PatternNoMatchError(source);
        return new LogEvent(fields, createMetadata());
      },
    };
  }
}

function matchWith(
  regex: RegExp,
  captures: readonly CaptureInfo[],
  text: string,
): ValueMap | undefined {
  const m = regex.exec(text);
  if (m === null) return undefined;
  const groups = (m.groups ?? {}) as Record<string, string | undefined>;
  const out: ValueMap = new Map();
  for (const cap of captures) {
    const raw = groups[cap.internalName];
    if (raw === undefined) continue;
    out.set(cap.fieldName, convert(raw, cap.type));
  }
  return out;
}

function convert(raw: string, type: CaptureType): Value {
  switch (type) {
    case 'string':
      return raw;
    case 'int':
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new CodecSyntaxError(
          CODEC,
          'E_PATTERN_TYPE',
          `capture is not a valid integer: ${JSON.stringify(raw)}`,
        );
      }
      return BigInt(raw);
    case 'float': {
      const n = Number(raw);
      if (Number.isNaN(n) && raw.trim() !== 'NaN') {
        throw new CodecSyntaxError(
          CODEC,
          'E_PATTERN_TYPE',
          `capture is not a valid number: ${JSON.stringify(raw)}`,
        );
      }
      return n;
    }
    case 'timestamp': {
      const t = Timestamp.tryParse(raw);
      if (t === undefined) {
        throw new CodecSyntaxError(
          CODEC,
          'E_PATTERN_TYPE',
          `capture is not an RFC 3339 timestamp: ${JSON.stringify(raw)}`,
        );
      }
      return t;
    }
  }
}

/**
 * Best-effort static guard against the most common shape of catastrophic backtracking: two
 * unbounded wildcard quantifiers (`.*`, `.+`) with nothing but pattern-generated group syntax
 * between them, which lets the engine try exponentially many ways to split the matched text
 * between them. This is a heuristic, not a guarantee — it catches the common case of chaining
 * `%{GREEDYDATA}`-like fragments directly together, but a sufficiently creative custom pattern can
 * still be slow. Prefer non-greedy fragments (like the built-in `DATA`) when two wildcards must be
 * adjacent.
 */
function checkBacktrackingRisk(source: string): void {
  const spans: Array<[number, number]> = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === ']') {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (c === '.' && (source[i + 1] === '*' || source[i + 1] === '+')) {
      spans.push([i, i + 2]);
      i++;
    }
  }
  for (let i = 1; i < spans.length; i++) {
    const between = source.slice(spans[i - 1]![1], spans[i]![0]);
    if (isOnlyGroupSyntax(between)) {
      throw new CodecSyntaxError(
        CODEC,
        'E_PATTERN_BACKTRACK_RISK',
        'pattern chains two unbounded wildcards with nothing but grouping between them, risking catastrophic backtracking; use a non-greedy fragment (e.g. DATA instead of GREEDYDATA) or add a literal separator',
      );
    }
  }
}

function isOnlyGroupSyntax(s: string): boolean {
  return s.replace(/\(\?<[A-Za-z0-9_]+>|\(\?:|\(|\)/g, '') === '';
}
