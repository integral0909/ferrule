import type { Span } from './source.js';

/** Keywords reserved by Ferrule Script. Every other identifier-shaped word is a plain identifier. */
export const KEYWORDS = [
  'let',
  'mut',
  'if',
  'else',
  'match',
  'true',
  'false',
  'null',
  'drop',
  'abort',
  'test',
  'given',
  'expect',
  'is',
] as const;

export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);

export function isKeyword(text: string): text is Keyword {
  return KEYWORD_SET.has(text);
}

/** One piece of a (possibly interpolated) string literal. */
export type StringPart =
  | { readonly kind: 'text'; readonly value: string }
  /** `{{ expr }}`. `span` covers just the expression source, not the braces. */
  | { readonly kind: 'interpolation'; readonly span: Span };

export type TokenKind =
  | 'eof'
  | 'newline'
  | 'identifier'
  | Keyword
  | 'int'
  | 'float'
  | 'string'
  | 'rawString'
  | 'byteString'
  | 'timestamp'
  | 'regex'
  | 'path'
  | 'metadataPath'
  // punctuation & operators
  | '('
  | ')'
  | '['
  | ']'
  | '{'
  | '}'
  | ','
  | ':'
  | ';'
  | '.'
  | '='
  | '=>'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '!'
  | '??'
  | '||'
  | '&&'
  | '|'
  | '_'
  | 'error';

export interface TokenBase {
  readonly kind: TokenKind;
  readonly span: Span;
  /** The exact source text of the token. */
  readonly text: string;
  /** True if a newline (outside of an escaped line continuation) preceded this token. */
  readonly precededByNewline: boolean;
}

export interface IdentifierToken extends TokenBase {
  readonly kind: 'identifier';
}

export interface IntToken extends TokenBase {
  readonly kind: 'int';
  readonly value: bigint;
  /** True if the literal's magnitude exceeds `int64::MAX` (still fits `-int64::MIN`). */
  readonly outOfRange: boolean;
}

export interface FloatToken extends TokenBase {
  readonly kind: 'float';
  readonly value: number;
}

export interface StringToken extends TokenBase {
  readonly kind: 'string';
  readonly parts: readonly StringPart[];
}

export interface RawStringToken extends TokenBase {
  readonly kind: 'rawString';
  readonly value: string;
}

export interface ByteStringToken extends TokenBase {
  readonly kind: 'byteString';
  readonly value: Uint8Array;
}

export interface TimestampToken extends TokenBase {
  readonly kind: 'timestamp';
  readonly value: string;
}

export interface RegexToken extends TokenBase {
  readonly kind: 'regex';
  readonly pattern: string;
  readonly flags: string;
}

export interface PathToken extends TokenBase {
  readonly kind: 'path';
  readonly segments: readonly (string | number)[];
}

export interface MetadataPathToken extends TokenBase {
  readonly kind: 'metadataPath';
  readonly name: string;
}

export interface ErrorToken extends TokenBase {
  readonly kind: 'error';
}

export interface SimpleToken extends TokenBase {
  kind: Exclude<
    TokenKind,
    | 'identifier'
    | 'int'
    | 'float'
    | 'string'
    | 'rawString'
    | 'byteString'
    | 'timestamp'
    | 'regex'
    | 'path'
    | 'metadataPath'
    | 'error'
  >;
}

export type Token =
  | IdentifierToken
  | IntToken
  | FloatToken
  | StringToken
  | RawStringToken
  | ByteStringToken
  | TimestampToken
  | RegexToken
  | PathToken
  | MetadataPathToken
  | ErrorToken
  | SimpleToken;

export function tokenText(kind: TokenKind): string {
  return kind;
}
