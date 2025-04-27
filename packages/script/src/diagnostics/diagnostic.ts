import type { Span } from '../syntax/source.js';

export type Severity = 'error' | 'warning' | 'note';

/** A single text replacement, used to build suggested fixes. */
export interface TextEdit {
  readonly span: Span;
  readonly newText: string;
}

/** A suggested fix: a human-readable description plus the edits that apply it. */
export interface Fix {
  readonly description: string;
  readonly edits: readonly TextEdit[];
}

/** A span with an explanatory message, rendered as an annotation under the source snippet. */
export interface Label {
  readonly span: Span;
  readonly message: string;
}

/**
 * A diagnostic: an error, warning, or note produced while lexing, parsing, or checking a
 * program. Every diagnostic carries a stable {@link code} (see {@link DIAGNOSTICS}) so tooling
 * and tests can match on it independently of the message text.
 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly primary: Label;
  readonly secondary: readonly Label[];
  readonly notes: readonly string[];
  readonly fixes: readonly Fix[];
}

export interface DiagnosticInit {
  readonly code: string;
  readonly severity?: Severity;
  readonly message: string;
  readonly span: Span;
  readonly labelMessage?: string;
  readonly secondary?: readonly Label[];
  readonly notes?: readonly string[];
  readonly fixes?: readonly Fix[];
}

/** Builds a {@link Diagnostic}, looking up the default severity from {@link DIAGNOSTICS} when omitted. */
export function makeDiagnostic(init: DiagnosticInit): Diagnostic {
  const meta = DIAGNOSTICS[init.code];
  return {
    code: init.code,
    severity: init.severity ?? meta?.severity ?? 'error',
    message: init.message,
    primary: { span: init.span, message: init.labelMessage ?? init.message },
    secondary: init.secondary ?? [],
    notes: init.notes ?? [],
    fixes: init.fixes ?? [],
  };
}

/** An explanation of a diagnostic code, for `ferrule explain <code>` and documentation. */
export interface DiagnosticCatalogEntry {
  readonly code: string;
  readonly severity: Severity;
  readonly summary: string;
  readonly explanation: string;
}

function entry(
  code: string,
  severity: Severity,
  summary: string,
  explanation: string,
): DiagnosticCatalogEntry {
  return { code, severity, summary, explanation };
}

/**
 * The catalog of every diagnostic code Ferrule Script's front end can produce. Codes are grouped
 * by phase: `E0xx` lexer, `E1xx` parser, `E2xx` resolver/scope, `E3xx` type checker, `E4xx`
 * fallibility, `W5xx`/`Wxx` warnings.
 */
export const DIAGNOSTIC_CATALOG: readonly DiagnosticCatalogEntry[] = [
  entry(
    'E001',
    'error',
    'unterminated string',
    'A string literal was not closed before the end of the line or file.',
  ),
  entry(
    'E002',
    'error',
    'invalid escape sequence',
    'A backslash escape inside a string is not recognised.',
  ),
  entry(
    'E003',
    'error',
    'unterminated interpolation',
    'A `{{` inside a string was never closed with `}}`.',
  ),
  entry(
    'E004',
    'error',
    'invalid number literal',
    'A numeric literal is malformed, for example a bare `0x` with no digits.',
  ),
  entry(
    'E005',
    'error',
    'integer literal out of range',
    'An integer literal does not fit in a signed 64-bit integer.',
  ),
  entry('E006', 'error', 'unterminated raw string', "A raw string (`r'...'`) was not closed."),
  entry('E007', 'error', 'unterminated byte string', 'A byte string (`b"..."`) was not closed.'),
  entry(
    'E008',
    'error',
    'unterminated timestamp literal',
    "A timestamp literal (`t'...'`) was not closed.",
  ),
  entry(
    'E009',
    'error',
    'invalid timestamp literal',
    'A timestamp literal is not a valid RFC 3339 timestamp.',
  ),
  entry(
    'E010',
    'error',
    'unterminated regex literal',
    'A regex literal (`r/.../`) was not closed.',
  ),
  entry(
    'E011',
    'error',
    'invalid regex flags',
    'A regex literal has a flag other than `i`, `m`, `s`, or `u`.',
  ),
  entry(
    'E012',
    'error',
    'invalid regex pattern',
    'A regex literal is not a valid regular expression.',
  ),
  entry(
    'E013',
    'error',
    'unexpected character',
    'A character does not begin any recognised token.',
  ),
  entry('E014', 'error', 'invalid path', 'A path literal is malformed.'),
  entry('E015', 'error', 'invalid metadata path', 'A metadata path (`%name`) is malformed.'),
  entry(
    'E101',
    'error',
    'unexpected token',
    'The parser encountered a token it did not expect at this point.',
  ),
  entry(
    'E102',
    'error',
    'expected expression',
    'An expression was expected but the next token cannot start one.',
  ),
  entry(
    'E103',
    'error',
    'expected statement terminator',
    'A statement must end with a newline or `;`.',
  ),
  entry('E104', 'error', 'expected identifier', 'An identifier was expected.'),
  entry('E105', 'error', 'expected pattern', 'A `match` arm pattern was expected.'),
  entry(
    'E106',
    'error',
    'duplicate named argument',
    'A named argument was passed more than once in the same call.',
  ),
  entry(
    'E107',
    'error',
    'positional argument after named argument',
    'Positional arguments must come before named arguments.',
  ),
  entry(
    'E108',
    'error',
    'invalid assignment target',
    'The left-hand side of `=` must be a path or a mutable variable.',
  ),
  entry('E109', 'error', 'expected block', 'A `{ ... }` block was expected.'),
  entry('E110', 'error', 'duplicate object key', 'An object literal repeats the same key.'),
  entry('E111', 'error', 'invalid closure parameters', 'A closure parameter list is malformed.'),
  entry(
    'E112',
    'error',
    "expected '=>'",
    'A match arm must separate its pattern from its body with `=>`.',
  ),
  entry(
    'E201',
    'error',
    'undefined variable',
    'A variable is used before it is declared, or is not in scope.',
  ),
  entry(
    'E202',
    'error',
    'undefined function',
    'A function name does not match any registered function.',
  ),
  entry(
    'E203',
    'error',
    'duplicate variable',
    'A `let` re-declares a name already bound in the same scope.',
  ),
  entry(
    'E204',
    'error',
    'assignment to immutable variable',
    'A variable bound with `let` (not `let mut`) was reassigned.',
  ),
  entry('E205', 'warning', 'unused variable', 'A variable is bound but never read.'),
  entry(
    'E206',
    'warning',
    'unreachable code',
    'Code after `drop`, `abort`, or a diverging branch can never run.',
  ),
  entry(
    'E301',
    'error',
    'type mismatch',
    'A value of one type was used where another type was required.',
  ),
  entry(
    'E302',
    'error',
    'unknown field',
    'An object shape does not have the field being accessed.',
  ),
  entry(
    'E303',
    'error',
    'wrong argument count',
    'A function call passes too few or too many arguments.',
  ),
  entry(
    'E304',
    'error',
    'unknown parameter',
    'A named argument does not match any parameter of the function.',
  ),
  entry(
    'E305',
    'error',
    'mixed int/float',
    'Arithmetic operators require both operands to be the same numeric type.',
  ),
  entry(
    'E306',
    'error',
    'non-boolean condition',
    '`if` conditions and `&&`/`||` operands must be `bool`.',
  ),
  entry(
    'E307',
    'error',
    'not indexable',
    'The indexing operator `[]` was used on a non-array, non-object value.',
  ),
  entry('E308', 'error', 'not callable', "A call expression's target is not a function."),
  entry(
    'E309',
    'error',
    'non-exhaustive match',
    'A `match` expression does not cover every possible case and has no wildcard arm.',
  ),
  entry(
    'E310',
    'error',
    'duplicate match arm',
    'A literal pattern is repeated in the same `match`.',
  ),
  entry(
    'E401',
    'error',
    'unhandled fallible expression',
    'A `T!` expression was used without `??`, `!`, or error capture.',
  ),
  entry(
    'E402',
    'error',
    'redundant fallibility handling',
    '`??`, `!`, or error capture was used on an expression that cannot fail.',
  ),
  entry(
    'W501',
    'warning',
    'redundant `??`',
    'The fallback of `??` can never be used because the left side cannot be `null`.',
  ),
  entry(
    'W502',
    'warning',
    'unused `err` binding',
    'An error-capture binding is never read; consider `let v, _ = expr`.',
  ),
];

const catalogByCode: ReadonlyMap<string, DiagnosticCatalogEntry> = new Map(
  DIAGNOSTIC_CATALOG.map((e) => [e.code, e]),
);

const DIAGNOSTICS: Record<string, { severity: Severity }> = Object.fromEntries(
  DIAGNOSTIC_CATALOG.map((e) => [e.code, { severity: e.severity }]),
);

/** Looks up a diagnostic code's catalog entry, for `ferrule explain`. */
export function explainCode(code: string): DiagnosticCatalogEntry | undefined {
  return catalogByCode.get(code);
}

/** A `did you mean` note for an unresolved name. */
export function didYouMeanNote(candidate: string): string {
  return `a similarly named identifier exists: \`${candidate}\` — did you mean this?`;
}
