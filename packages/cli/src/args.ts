import { parseDuration } from '@ferrule/core';
import { closestMatch } from '@ferrule/schema';

/**
 * A hand-written argument parser for `ferrule` and its subcommands. Node stdlib only.
 *
 * Supports long (`--flag value`, `--flag=value`) and short (`-f value`) flags, boolean flags with
 * `--no-` negation, repeated flags (collected into an array), typed values (`string`, `integer`,
 * `duration`, `path`, `enum`), required/optional positionals (including a variadic trailing one),
 * a `--` terminator (everything after is positional even if it looks like a flag), unknown-flag
 * errors with a "did you mean" suggestion, and generated `--help` text.
 */

export type FlagType = 'boolean' | 'string' | 'integer' | 'number' | 'duration' | 'path' | 'enum';

export type FlagValue = string | number | boolean | readonly string[] | readonly number[];

export interface FlagSpec {
  /** Canonical long name, kebab-case, e.g. `log-level`. Used as the key in {@link ParsedArgs.flags}. */
  readonly name: string;
  /** A single-character alias, e.g. `c` for `-c`. */
  readonly short?: string;
  readonly type: FlagType;
  readonly description: string;
  /** Allowed values, required when `type` is `enum`. */
  readonly enumValues?: readonly string[];
  /** Collects every occurrence into an array instead of the last one winning. */
  readonly repeatable?: boolean;
  /** Accepts `--no-<name>` to set a boolean flag to `false` explicitly. `boolean` only. */
  readonly negatable?: boolean;
  /** Placeholder shown in generated help, e.g. `<level>`. Defaults to `<name>` (or nothing for booleans). */
  readonly metavar?: string;
  readonly default?: FlagValue;
  /** Hidden from generated help (used for flags kept for compatibility, or internal test-only ones). */
  readonly hidden?: boolean;
}

export interface PositionalSpec {
  readonly name: string;
  readonly description: string;
  /** Consumes every remaining positional argument. Only the last positional may be variadic. */
  readonly variadic?: boolean;
  readonly required?: boolean;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  /** Overrides the auto-generated usage line. */
  readonly usage?: string;
  readonly flags: readonly FlagSpec[];
  readonly positionals?: readonly PositionalSpec[];
  readonly examples?: readonly string[];
}

export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, FlagValue>;
  readonly positionals: readonly string[];
}

export type ParseOutcome =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly message: string };

const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'help', short: 'h', type: 'boolean', description: 'Show help for this command.' },
  {
    name: 'debug',
    type: 'boolean',
    description: 'Show full error stacks instead of short messages.',
  },
];

/** Merges the flags every command accepts (`--help`, `--debug`) into `spec`. */
export function withGlobalFlags(spec: CommandSpec): CommandSpec {
  const existing = new Set(spec.flags.map((f) => f.name));
  const extra = GLOBAL_FLAGS.filter((f) => !existing.has(f.name));
  return { ...spec, flags: [...spec.flags, ...extra] };
}

interface TokenEntry {
  readonly flag: FlagSpec;
  readonly negate: boolean;
}

function buildTokenMap(flags: readonly FlagSpec[]): Map<string, TokenEntry> {
  const map = new Map<string, TokenEntry>();
  for (const flag of flags) {
    map.set(`--${flag.name}`, { flag, negate: false });
    if (flag.short !== undefined) map.set(`-${flag.short}`, { flag, negate: false });
    if (flag.type === 'boolean' && flag.negatable === true) {
      map.set(`--no-${flag.name}`, { flag, negate: true });
    }
  }
  return map;
}

function isFlagLike(token: string): boolean {
  if (!token.startsWith('-') || token === '-') return false;
  // A lone `-3` / `-3.5` reads as a negative number, not a flag, so numeric positionals work.
  return !/^-\d/.test(token);
}

function convertScalar(
  flag: FlagSpec,
  raw: string,
): { ok: true; value: string | number } | { ok: false; message: string } {
  switch (flag.type) {
    case 'string':
    case 'path':
      return { ok: true, value: raw };
    case 'integer': {
      if (!/^[+-]?\d+$/.test(raw)) {
        return { ok: false, message: `expected an integer, got ${JSON.stringify(raw)}` };
      }
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) return { ok: false, message: `integer out of range: ${raw}` };
      return { ok: true, value: n };
    }
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) {
        return { ok: false, message: `expected a number, got ${JSON.stringify(raw)}` };
      }
      return { ok: true, value: n };
    }
    case 'duration': {
      try {
        return { ok: true, value: Number(parseDuration(raw) / 1_000_000n) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'enum': {
      const values = flag.enumValues ?? [];
      if (!values.includes(raw)) {
        const suggestion = closestMatch(raw, values);
        const allowed = values.map((v) => JSON.stringify(v)).join(', ');
        return {
          ok: false,
          message:
            `expected one of ${allowed}, got ${JSON.stringify(raw)}` +
            (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
        };
      }
      return { ok: true, value: raw };
    }
    case 'boolean':
      throw new Error('unreachable: boolean flags do not take a scalar value');
  }
}

function setFlag(
  values: Map<string, FlagValue>,
  flag: FlagSpec,
  value: string | number | boolean,
): void {
  if (!flag.repeatable) {
    values.set(flag.name, value);
    return;
  }
  const existing = values.get(flag.name);
  // `Array.isArray` is typed `(arg: any) => arg is any[]` in lib.es5, so it doesn't actually
  // narrow `existing`'s element type; the explicit cast (not `existing` itself) is what keeps
  // this safe, since every write to a repeatable flag's array goes through this same function.
  const list: (string | number)[] = Array.isArray(existing)
    ? [...(existing as readonly (string | number)[])]
    : [];
  list.push(value as string | number);
  // Repeatable flags are always homogeneously typed (one FlagSpec, one `type`), so the array is
  // always all-string or all-number in practice; FlagValue just can't express "array of the same
  // type as this specific flag" without a generic per-flag type parameter.
  values.set(flag.name, list as unknown as readonly string[] | readonly number[]);
}

function parseBooleanLiteral(text: string): boolean | undefined {
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return undefined;
}

/** Parses `argv` against `spec` (which should already include global flags via {@link withGlobalFlags}). */
export function parseArgs(spec: CommandSpec, argv: readonly string[]): ParseOutcome {
  const tokenMap = buildTokenMap(spec.flags);
  const values = new Map<string, FlagValue>();
  const positionals: string[] = [];
  let terminated = false;
  let i = 0;

  while (i < argv.length) {
    const token = argv[i]!;
    if (!terminated && token === '--') {
      terminated = true;
      i++;
      continue;
    }
    if (!terminated && isFlagLike(token)) {
      let lookupToken = token;
      let inlineValue: string | undefined;
      if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        if (eq !== -1) {
          lookupToken = token.slice(0, eq);
          inlineValue = token.slice(eq + 1);
        }
      }
      const entry = tokenMap.get(lookupToken);
      if (entry === undefined) {
        const candidates = [...tokenMap.keys()];
        const bare = lookupToken.replace(/^-+/, '');
        const suggestion = closestMatch(
          bare,
          candidates.map((c) => c.replace(/^-+/, '')),
        );
        return {
          ok: false,
          message:
            `unknown flag ${lookupToken}` +
            (suggestion === undefined ? '' : ` (did you mean --${suggestion}?)`),
        };
      }
      const { flag, negate } = entry;
      if (flag.type === 'boolean') {
        if (inlineValue !== undefined) {
          const b = parseBooleanLiteral(inlineValue);
          if (b === undefined) {
            return {
              ok: false,
              message: `invalid value for ${lookupToken}: ${JSON.stringify(inlineValue)}`,
            };
          }
          setFlag(values, flag, negate ? !b : b);
        } else {
          setFlag(values, flag, !negate);
        }
        i++;
        continue;
      }
      let raw: string;
      if (inlineValue !== undefined) {
        raw = inlineValue;
        i++;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          return { ok: false, message: `flag --${flag.name} requires a value` };
        }
        raw = next;
        i += 2;
      }
      const converted = convertScalar(flag, raw);
      if (!converted.ok) {
        return { ok: false, message: `invalid value for --${flag.name}: ${converted.message}` };
      }
      setFlag(values, flag, converted.value);
      continue;
    }
    positionals.push(token);
    i++;
  }

  for (const flag of spec.flags) {
    if (!values.has(flag.name) && flag.default !== undefined) values.set(flag.name, flag.default);
  }

  const posSpecs = spec.positionals ?? [];
  for (let p = 0; p < posSpecs.length; p++) {
    const posSpec = posSpecs[p]!;
    const isLast = p === posSpecs.length - 1;
    if (posSpec.variadic && !isLast) {
      throw new Error(`command ${spec.name}: only the last positional may be variadic`);
    }
    const remaining = positionals.length - p;
    if (posSpec.required === true && remaining <= 0) {
      return { ok: false, message: `missing required argument <${posSpec.name}>` };
    }
  }
  const maxFixed = posSpecs.some((p) => p.variadic) ? Infinity : posSpecs.length;
  if (positionals.length > maxFixed) {
    return { ok: false, message: `unexpected argument ${JSON.stringify(positionals[maxFixed])}` };
  }

  return { ok: true, args: { flags: values, positionals } };
}

// ---------------------------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------------------------

export function flagBoolean(args: ParsedArgs, name: string, fallback = false): boolean {
  const v = args.flags.get(name);
  return typeof v === 'boolean' ? v : fallback;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags.get(name);
  return typeof v === 'number' ? v : undefined;
}

export function flagStringArray(args: ParsedArgs, name: string): readonly string[] {
  const v = args.flags.get(name);
  if (Array.isArray(v)) return v as readonly string[];
  return typeof v === 'string' ? [v] : [];
}

// ---------------------------------------------------------------------------------------------
// Help rendering
// ---------------------------------------------------------------------------------------------

function flagUsageToken(flag: FlagSpec): string {
  if (flag.type === 'boolean') return `--${flag.name}`;
  const metavar = flag.metavar ?? `<${flag.name}>`;
  return `--${flag.name} ${metavar}`;
}

export function formatCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  const usage =
    spec.usage ??
    [
      `ferrule ${spec.name}`,
      spec.flags.length > 0 ? '[options]' : undefined,
      ...(spec.positionals ?? []).map(
        (p) =>
          `${p.required ? '<' : '['}${p.name}${p.variadic ? '...' : ''}${p.required ? '>' : ']'}`,
      ),
    ]
      .filter((part): part is string => part !== undefined)
      .join(' ');

  lines.push(spec.summary);
  lines.push('');
  lines.push(`Usage: ${usage}`);

  if (spec.positionals !== undefined && spec.positionals.length > 0) {
    lines.push('');
    lines.push('Arguments:');
    for (const p of spec.positionals) {
      lines.push(`  ${p.name.padEnd(20)}${p.description}`);
    }
  }

  const visibleFlags = spec.flags.filter((f) => !f.hidden);
  if (visibleFlags.length > 0) {
    lines.push('');
    lines.push('Options:');
    for (const flag of visibleFlags) {
      const short = flag.short !== undefined ? `-${flag.short}, ` : '    ';
      const token = flagUsageToken(flag);
      const extra =
        flag.type === 'enum' && flag.enumValues !== undefined
          ? ` (one of: ${flag.enumValues.join(', ')})`
          : '';
      const defaultNote = flag.default !== undefined ? ` [default: ${String(flag.default)}]` : '';
      lines.push(`  ${short}${token.padEnd(28)}${flag.description}${extra}${defaultNote}`);
    }
  }

  if (spec.examples !== undefined && spec.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const example of spec.examples) lines.push(`  ${example}`);
  }

  return lines.join('\n');
}

export interface TopLevelCommandSummary {
  readonly name: string;
  readonly summary: string;
}

export function formatTopLevelHelp(
  commands: readonly TopLevelCommandSummary[],
  version: string,
): string {
  const width = Math.max(...commands.map((c) => c.name.length)) + 2;
  const lines: string[] = [
    `ferrule ${version} — a telemetry pipeline for logs, metrics, and traces`,
    '',
    'Usage: ferrule <command> [options]',
    '',
    'Commands:',
    ...commands.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    '',
    'Global options:',
    '  -h, --help        Show help for a command.',
    '      --debug       Show full error stacks instead of short messages.',
    '      --version     Show the ferrule version.',
    '',
    "Run 'ferrule <command> --help' for details on a specific command.",
  ];
  return lines.join('\n');
}
