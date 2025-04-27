import { Timestamp } from '@ferrule/core';
import { makeDiagnostic, type Diagnostic } from '../diagnostics/diagnostic.js';
import type { Span } from './source.js';
import type { SourceFile } from './source.js';
import { isKeyword, type Token, type TokenKind } from './tokens.js';

/** A comment attached to a token as leading or trailing trivia. */
export interface CommentTrivia {
  readonly text: string;
  readonly span: Span;
  /** True if a blank line separates this comment from whatever preceded it. */
  readonly blankLineBefore: boolean;
}

/** A lexed token together with the comments the formatter needs to reproduce it faithfully. */
export interface LexedToken {
  readonly token: Token;
  readonly leadingComments: readonly CommentTrivia[];
  readonly trailingComment: CommentTrivia | undefined;
}

export interface LexResult {
  readonly tokens: readonly LexedToken[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface LexRange {
  readonly start?: number;
  readonly end?: number;
}

/** Token kinds that complete an expression atom; a `.` right after one is postfix field access. */
const ATOM_END_KINDS: ReadonlySet<TokenKind> = new Set([
  'identifier',
  'true',
  'false',
  'null',
  'int',
  'float',
  'string',
  'rawString',
  'byteString',
  'timestamp',
  'regex',
  'path',
  'metadataPath',
  ')',
  ']',
  '}',
]);

/** Token kinds after which a trailing newline is a line continuation, not a statement break. */
const CONTINUATION_KINDS: ReadonlySet<TokenKind> = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '&&',
  '||',
  '??',
  '=',
  '=>',
  ',',
  ':',
  '.',
  '(',
  '[',
  '|',
  'is',
]);

const ID_START = /[A-Za-z_]/;
const ID_CONT = /[A-Za-z0-9_]/;

/**
 * Tokenizes Ferrule Script source text. Never throws: malformed input produces `error` tokens
 * plus diagnostics, so the parser can still run and report every problem in one pass.
 *
 * `range`, when given, lexes only `[start, end)` of `source.text` (used to re-lex a string
 * interpolation's expression text) while keeping token spans absolute.
 */
export function lex(source: SourceFile, range?: LexRange): LexResult {
  return new Lexer(source, range).run();
}

class Lexer {
  private readonly text: string;
  private readonly end: number;
  private pos: number;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly tokens: LexedToken[] = [];
  private parenDepth = 0;
  private lastSignificantKind: TokenKind | undefined;
  private pendingComments: CommentTrivia[] = [];
  private sawBlankLine = false;

  constructor(source: SourceFile, range?: LexRange) {
    this.text = source.text;
    this.pos = range?.start ?? 0;
    this.end = range?.end ?? source.text.length;
  }

  run(): LexResult {
    for (;;) {
      const trivia = this.skipTriviaAndComments();
      if (trivia === 'newline') {
        this.maybeEmitNewline();
        continue;
      }
      if (this.pos >= this.end) break;
      const before = this.tokens.length;
      this.scanToken();
      if (this.tokens.length === before) break; // safety net against an infinite loop
    }
    this.emitSimple('eof', this.end, this.end);
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  // ---- trivia -------------------------------------------------------------------------------

  /** Skips spaces/tabs and comments; returns `'newline'` if a line break was crossed. */
  private skipTriviaAndComments(): 'newline' | 'none' {
    let sawNewline = false;
    for (;;) {
      const c = this.peekChar();
      if (c === ' ' || c === '\t' || c === '\r') {
        this.pos++;
      } else if (c === '\n') {
        if (sawNewline) this.sawBlankLine = true;
        sawNewline = true;
        this.pos++;
      } else if (c === '#') {
        const start = this.pos;
        while (this.pos < this.end && this.text.charCodeAt(this.pos) !== 10) this.pos++;
        const commentSpan = { start, end: this.pos };
        const text = this.text.slice(start + 1, this.pos).replace(/^\s/, '');
        if (sawNewline || this.tokens.length === 0) {
          this.pendingComments.push({
            text,
            span: commentSpan,
            blankLineBefore: this.sawBlankLine,
          });
          this.sawBlankLine = false;
        } else {
          this.attachTrailingComment({ text, span: commentSpan, blankLineBefore: false });
        }
      } else {
        break;
      }
    }
    return sawNewline ? 'newline' : 'none';
  }

  private attachTrailingComment(comment: CommentTrivia): void {
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.trailingComment === undefined) {
      (last as { trailingComment: CommentTrivia | undefined }).trailingComment = comment;
    }
  }

  private maybeEmitNewline(): void {
    if (this.parenDepth > 0) return;
    if (
      this.lastSignificantKind !== undefined &&
      CONTINUATION_KINDS.has(this.lastSignificantKind)
    ) {
      return;
    }
    if (this.lastSignificantKind === undefined) return; // no statement started yet
    // Pushed directly (not through `push`/`emitSimple`): a comment just skipped by
    // `skipTriviaAndComments` belongs to the next *real* token (or EOF), not to this synthetic
    // separator, so `pendingComments` must survive this push untouched.
    this.tokens.push({
      token: {
        kind: 'newline',
        span: { start: this.pos, end: this.pos },
        text: '',
        precededByNewline: false,
      },
      leadingComments: [],
      trailingComment: undefined,
    });
    this.lastSignificantKind = 'newline';
  }

  private peekChar(offset = 0): string {
    const i = this.pos + offset;
    return i < this.end ? this.text[i]! : '\0';
  }

  // ---- dispatch -------------------------------------------------------------------------------

  private scanToken(): void {
    const c = this.peekChar();
    if (ID_START.test(c)) {
      this.scanIdentifierLike();
      return;
    }
    if (/[0-9]/.test(c)) {
      this.scanNumber();
      return;
    }
    switch (c) {
      case '"':
        this.scanString();
        return;
      case '.':
        this.scanDotOrPath();
        return;
      case '%':
        this.scanPercentOrMetadataPath();
        return;
      case '(':
        this.parenDepth++;
        this.emitPunct('(');
        return;
      case ')':
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        this.emitPunct(')');
        return;
      case '[':
        this.parenDepth++;
        this.emitPunct('[');
        return;
      case ']':
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        this.emitPunct(']');
        return;
      case '{':
        this.emitPunct('{');
        return;
      case '}':
        this.emitPunct('}');
        return;
      case ',':
        this.emitPunct(',');
        return;
      case ':':
        this.emitPunct(':');
        return;
      case ';':
        this.emitPunct(';');
        return;
      case '_':
        this.scanIdentifierLike();
        return;
      case '=':
        if (this.peekChar(1) === '=') this.emitPunct('==', 2);
        else if (this.peekChar(1) === '>') this.emitPunct('=>', 2);
        else this.emitPunct('=');
        return;
      case '!':
        if (this.peekChar(1) === '=') this.emitPunct('!=', 2);
        else this.emitPunct('!');
        return;
      case '<':
        if (this.peekChar(1) === '=') this.emitPunct('<=', 2);
        else this.emitPunct('<');
        return;
      case '>':
        if (this.peekChar(1) === '=') this.emitPunct('>=', 2);
        else this.emitPunct('>');
        return;
      case '+':
        this.emitPunct('+');
        return;
      case '-':
        this.emitPunct('-');
        return;
      case '*':
        this.emitPunct('*');
        return;
      case '/':
        this.emitPunct('/');
        return;
      case '?':
        if (this.peekChar(1) === '?') this.emitPunct('??', 2);
        else this.scanUnexpected();
        return;
      case '&':
        if (this.peekChar(1) === '&') this.emitPunct('&&', 2);
        else this.scanUnexpected();
        return;
      case '|':
        if (this.peekChar(1) === '|') this.emitPunct('||', 2);
        else this.emitPunct('|');
        return;
      default:
        this.scanUnexpected();
        return;
    }
  }

  private scanUnexpected(): void {
    const start = this.pos;
    this.pos++;
    const span = { start, end: this.pos };
    this.diagnostics.push(
      makeDiagnostic({
        code: 'E013',
        message: `unexpected character ${JSON.stringify(this.text.slice(start, this.pos))}`,
        span,
      }),
    );
    this.push({
      kind: 'error',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
    });
  }

  // ---- identifiers, keywords, prefixed literals ------------------------------------------------

  private scanIdentifierLike(): void {
    const start = this.pos;
    const c = this.peekChar();
    if ((c === 'r' || c === 'R') && this.peekChar(1) === "'") {
      this.scanRawString();
      return;
    }
    if ((c === 'r' || c === 'R') && this.peekChar(1) === '/') {
      this.scanRegex();
      return;
    }
    if ((c === 'b' || c === 'B') && this.peekChar(1) === '"') {
      this.scanByteString();
      return;
    }
    if ((c === 't' || c === 'T') && this.peekChar(1) === "'") {
      this.scanTimestamp();
      return;
    }
    while (this.pos < this.end && ID_CONT.test(this.peekChar())) this.pos++;
    const text = this.text.slice(start, this.pos);
    const span = { start, end: this.pos };
    if (text === '_') {
      this.push({ kind: '_', span, text, precededByNewline: false });
      this.recordSignificant('_');
      return;
    }
    if (isKeyword(text)) {
      this.push({ kind: text, span, text, precededByNewline: false });
      this.recordSignificant(text);
      return;
    }
    this.push({ kind: 'identifier', span, text, precededByNewline: false });
    this.recordSignificant('identifier');
  }

  // ---- numbers --------------------------------------------------------------------------------

  private scanNumber(): void {
    const start = this.pos;
    if (this.peekChar() === '0' && (this.peekChar(1) === 'x' || this.peekChar(1) === 'X')) {
      this.pos += 2;
      const digitsStart = this.pos;
      this.consumeDigitRun(/[0-9a-fA-F]/);
      if (this.pos === digitsStart) {
        this.errorHere('E004', 'hexadecimal literal has no digits', { start, end: this.pos });
      }
      this.finishInt(start, 16);
      return;
    }
    if (this.peekChar() === '0' && (this.peekChar(1) === 'b' || this.peekChar(1) === 'B')) {
      this.pos += 2;
      const digitsStart = this.pos;
      this.consumeDigitRun(/[01]/);
      if (this.pos === digitsStart) {
        this.errorHere('E004', 'binary literal has no digits', { start, end: this.pos });
      }
      this.finishInt(start, 2);
      return;
    }
    this.consumeDigitRun(/[0-9]/);
    let isFloat = false;
    if (this.peekChar() === '.' && /[0-9]/.test(this.peekChar(1))) {
      isFloat = true;
      this.pos++;
      this.consumeDigitRun(/[0-9]/);
    }
    if (this.peekChar() === 'e' || this.peekChar() === 'E') {
      const save = this.pos;
      let p = this.pos + 1;
      if (this.text[p] === '+' || this.text[p] === '-') p++;
      if (p < this.end && /[0-9]/.test(this.text[p]!)) {
        isFloat = true;
        this.pos = p;
        this.consumeDigitRun(/[0-9]/);
      } else {
        this.pos = save;
      }
    }
    if (isFloat) this.finishFloat(start);
    else this.finishInt(start, 10);
  }

  private consumeDigitRun(digit: RegExp): void {
    let lastWasDigit = false;
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (digit.test(c)) {
        this.pos++;
        lastWasDigit = true;
      } else if (c === '_' && lastWasDigit && digit.test(this.peekChar(1))) {
        this.pos++;
        lastWasDigit = false;
      } else {
        break;
      }
    }
  }

  private finishInt(start: number, radix: 10 | 16 | 2): void {
    const span = { start, end: this.pos };
    const raw = this.text.slice(start, this.pos).replace(/_/g, '');
    const digits = radix === 10 ? raw : raw.slice(2);
    let value: bigint;
    try {
      value = radix === 10 ? BigInt(digits) : BigInt(`0${radix === 16 ? 'x' : 'b'}${digits}`);
    } catch {
      value = 0n;
    }
    // A magnitude of exactly 2^63 is valid when the literal is the operand of a unary `-`
    // (it becomes int64::MIN); the parser is responsible for accepting that one case and
    // rejecting the literal everywhere else. Anything larger never fits, even negated.
    const outOfRange = value > 1n << 63n;
    if (outOfRange) {
      this.diagnostics.push(
        makeDiagnostic({
          code: 'E005',
          message: `integer literal ${raw} is out of int64 range`,
          span,
        }),
      );
    }
    this.push({
      kind: 'int',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      value,
      outOfRange,
    });
    this.recordSignificant('int');
  }

  private finishFloat(start: number): void {
    const span = { start, end: this.pos };
    const raw = this.text.slice(start, this.pos).replace(/_/g, '');
    const value = Number(raw);
    this.push({
      kind: 'float',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      value,
    });
    this.recordSignificant('float');
  }

  // ---- strings --------------------------------------------------------------------------------

  private scanString(): void {
    const start = this.pos;
    this.pos++; // opening quote
    const parts: ({ kind: 'text'; value: string } | { kind: 'interpolation'; span: Span })[] = [];
    let buffer = '';
    let terminated = false;
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (c === '"') {
        this.pos++;
        terminated = true;
        break;
      }
      if (c === '\n') break; // unterminated: strings don't span lines
      if (c === '\\') {
        buffer += this.scanEscape();
        continue;
      }
      if (c === '{' && this.peekChar(1) === '{') {
        if (buffer.length > 0) {
          parts.push({ kind: 'text', value: buffer });
          buffer = '';
        }
        parts.push(this.scanInterpolation());
        continue;
      }
      buffer += c;
      this.pos++;
    }
    if (buffer.length > 0 || parts.length === 0) parts.push({ kind: 'text', value: buffer });
    const span = { start, end: this.pos };
    if (!terminated) {
      this.diagnostics.push(
        makeDiagnostic({ code: 'E001', message: 'unterminated string literal', span }),
      );
    }
    this.push({
      kind: 'string',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      parts,
    });
    this.recordSignificant('string');
  }

  private scanEscape(): string {
    const backslashStart = this.pos;
    this.pos++; // backslash
    const c = this.peekChar();
    switch (c) {
      case 'n':
        this.pos++;
        return '\n';
      case 't':
        this.pos++;
        return '\t';
      case 'r':
        this.pos++;
        return '\r';
      case '\\':
        this.pos++;
        return '\\';
      case '"':
        this.pos++;
        return '"';
      case "'":
        this.pos++;
        return "'";
      case '0':
        this.pos++;
        return '\0';
      case '{':
        this.pos++;
        return '{';
      case 'x': {
        this.pos++;
        const hex = this.text.slice(this.pos, this.pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.pos += 2;
          return String.fromCharCode(parseInt(hex, 16));
        }
        this.errorHere('E002', 'invalid \\x escape: expected two hex digits', {
          start: backslashStart,
          end: this.pos,
        });
        return '';
      }
      case 'u': {
        this.pos++;
        if (this.peekChar() !== '{') {
          this.errorHere('E002', "invalid \\u escape: expected '{'", {
            start: backslashStart,
            end: this.pos,
          });
          return '';
        }
        this.pos++;
        const hexStart = this.pos;
        while (this.pos < this.end && /[0-9a-fA-F]/.test(this.peekChar())) this.pos++;
        const hex = this.text.slice(hexStart, this.pos);
        const ok = this.peekChar() === '}' && hex.length >= 1 && hex.length <= 6;
        if (this.peekChar() === '}') this.pos++;
        if (!ok) {
          this.errorHere('E002', 'invalid \\u{...} escape', {
            start: backslashStart,
            end: this.pos,
          });
          return '';
        }
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) {
          this.errorHere('E002', 'unicode escape out of range', {
            start: backslashStart,
            end: this.pos,
          });
          return '';
        }
        return String.fromCodePoint(code);
      }
      default: {
        this.pos += c === '\0' ? 0 : 1;
        this.errorHere('E002', `invalid escape sequence '\\${c}'`, {
          start: backslashStart,
          end: this.pos,
        });
        return '';
      }
    }
  }

  /**
   * Like {@link scanEscape}, but for byte strings: `\xHH` produces exactly that raw byte rather
   * than a Unicode code point that would then be re-encoded as UTF-8.
   */
  private scanByteEscape(): number[] {
    const backslashStart = this.pos;
    this.pos++; // backslash
    const c = this.peekChar();
    switch (c) {
      case 'n':
        this.pos++;
        return [10];
      case 't':
        this.pos++;
        return [9];
      case 'r':
        this.pos++;
        return [13];
      case '\\':
        this.pos++;
        return [92];
      case '"':
        this.pos++;
        return [34];
      case "'":
        this.pos++;
        return [39];
      case '0':
        this.pos++;
        return [0];
      case 'x': {
        this.pos++;
        const hex = this.text.slice(this.pos, this.pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.pos += 2;
          return [parseInt(hex, 16)];
        }
        this.errorHere('E002', 'invalid \\x escape: expected two hex digits', {
          start: backslashStart,
          end: this.pos,
        });
        return [];
      }
      default: {
        this.pos += c === '\0' ? 0 : 1;
        this.errorHere('E002', `invalid escape sequence '\\${c}' in a byte string`, {
          start: backslashStart,
          end: this.pos,
        });
        return [];
      }
    }
  }

  /** Scans `{{ ... }}`, balancing brackets/quotes so nested expressions can contain them. */
  private scanInterpolation(): { kind: 'interpolation'; span: Span } {
    this.pos += 2; // '{{'
    const innerStart = this.pos;
    let depth = 0;
    let closed = false;
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (c === '"') {
        this.skipNestedString('"');
        continue;
      }
      if ((c === 'r' || c === 'b' || c === 't') && this.peekChar(1) === "'") {
        this.pos++;
        this.skipNestedString("'");
        continue;
      }
      if (c === '{' || c === '(' || c === '[') {
        depth++;
        this.pos++;
        continue;
      }
      if (c === '}' && depth === 0 && this.peekChar(1) === '}') {
        closed = true;
        break;
      }
      if (c === ')' || c === ']' || c === '}') {
        depth = Math.max(0, depth - 1);
        this.pos++;
        continue;
      }
      if (c === '\n') break;
      this.pos++;
    }
    const innerEnd = this.pos;
    if (closed) {
      this.pos += 2; // '}}'
    } else {
      this.diagnostics.push(
        makeDiagnostic({
          code: 'E003',
          message: 'unterminated interpolation: expected `}}`',
          span: { start: innerStart - 2, end: innerEnd },
        }),
      );
    }
    return { kind: 'interpolation', span: { start: innerStart, end: innerEnd } };
  }

  private skipNestedString(quote: string): void {
    this.pos++; // opening quote
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (c === '\\' && quote === '"') {
        this.pos += 2;
        continue;
      }
      if (c === quote) {
        this.pos++;
        return;
      }
      if (c === '\n') return;
      this.pos++;
    }
  }

  private scanRawString(): void {
    const start = this.pos;
    this.pos += 2; // r'
    const valueStart = this.pos;
    let terminated = false;
    while (this.pos < this.end) {
      if (this.peekChar() === "'") {
        terminated = true;
        break;
      }
      this.pos++;
    }
    const value = this.text.slice(valueStart, this.pos);
    if (terminated) this.pos++;
    const span = { start, end: this.pos };
    if (!terminated) {
      this.diagnostics.push(
        makeDiagnostic({ code: 'E006', message: 'unterminated raw string literal', span }),
      );
    }
    this.push({
      kind: 'rawString',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      value,
    });
    this.recordSignificant('rawString');
  }

  private scanByteString(): void {
    const start = this.pos;
    this.pos += 2; // b"
    const bytes: number[] = [];
    let terminated = false;
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (c === '"') {
        this.pos++;
        terminated = true;
        break;
      }
      if (c === '\n') break;
      if (c === '\\') {
        for (const b of this.scanByteEscape()) bytes.push(b);
        continue;
      }
      const code = c.codePointAt(0)!;
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      this.pos += code > 0xffff ? 2 : 1;
    }
    const span = { start, end: this.pos };
    if (!terminated) {
      this.diagnostics.push(
        makeDiagnostic({ code: 'E007', message: 'unterminated byte string literal', span }),
      );
    }
    this.push({
      kind: 'byteString',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      value: Uint8Array.from(bytes),
    });
    this.recordSignificant('byteString');
  }

  private scanTimestamp(): void {
    const start = this.pos;
    this.pos += 2; // t'
    const valueStart = this.pos;
    let terminated = false;
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (c === "'") {
        terminated = true;
        break;
      }
      if (c === '\n') break;
      this.pos++;
    }
    const value = this.text.slice(valueStart, this.pos);
    if (terminated) this.pos++;
    const span = { start, end: this.pos };
    if (!terminated) {
      this.diagnostics.push(
        makeDiagnostic({ code: 'E008', message: 'unterminated timestamp literal', span }),
      );
    } else if (Timestamp.tryParse(value) === undefined) {
      this.diagnostics.push(
        makeDiagnostic({
          code: 'E009',
          message: `invalid RFC 3339 timestamp: ${JSON.stringify(value)}`,
          span,
        }),
      );
    }
    this.push({
      kind: 'timestamp',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      value,
    });
    this.recordSignificant('timestamp');
  }

  private scanRegex(): void {
    const start = this.pos;
    this.pos += 2; // r/
    const patternStart = this.pos;
    let inClass = false;
    let terminated = false;
    while (this.pos < this.end) {
      const c = this.peekChar();
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        terminated = true;
        break;
      } else if (c === '\n') {
        break;
      }
      this.pos++;
    }
    const pattern = this.text.slice(patternStart, this.pos);
    if (terminated) this.pos++;
    const flagsStart = this.pos;
    while (this.pos < this.end && /[a-zA-Z]/.test(this.peekChar())) this.pos++;
    const flags = this.text.slice(flagsStart, this.pos);
    const span = { start, end: this.pos };
    if (!terminated) {
      this.diagnostics.push(
        makeDiagnostic({ code: 'E010', message: 'unterminated regex literal', span }),
      );
    } else {
      const allowed = new Set(['i', 'm', 's', 'u']);
      const seen = new Set<string>();
      for (const f of flags) {
        if (!allowed.has(f) || seen.has(f)) {
          this.diagnostics.push(
            makeDiagnostic({
              code: 'E011',
              message: `invalid regex flag '${f}': only i, m, s, u are allowed, each at most once`,
              span,
            }),
          );
          break;
        }
        seen.add(f);
      }
      try {
        new RegExp(pattern, flags.replace(/[^gimsuy]/g, ''));
      } catch (cause) {
        this.diagnostics.push(
          makeDiagnostic({
            code: 'E012',
            message: `invalid regex pattern: ${cause instanceof Error ? cause.message : String(cause)}`,
            span,
          }),
        );
      }
    }
    this.push({
      kind: 'regex',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      pattern,
      flags,
    });
    this.recordSignificant('regex');
  }

  // ---- paths ----------------------------------------------------------------------------------

  private scanDotOrPath(): void {
    if (
      this.lastSignificantKind !== undefined &&
      ATOM_END_KINDS.has(this.lastSignificantKind) &&
      !(this.lastSignificantKind === 'path' || this.lastSignificantKind === 'metadataPath')
    ) {
      const start = this.pos;
      this.pos++;
      this.push({ kind: '.', span: { start, end: this.pos }, text: '.', precededByNewline: false });
      this.recordSignificant('.');
      return;
    }
    this.scanPathLiteral();
  }

  private scanPathLiteral(): void {
    const start = this.pos;
    const segments: (string | number)[] = [];
    let ok = true;
    this.pos++; // leading '.'

    const readField = (): void => {
      if (this.peekChar() === '"') {
        const qStart = this.pos;
        this.pos++;
        let value = '';
        let closed = false;
        while (this.pos < this.end) {
          const c = this.peekChar();
          if (c === '"') {
            closed = true;
            this.pos++;
            break;
          }
          if (c === '\n') break;
          if (c === '\\') {
            value += this.scanEscape();
            continue;
          }
          value += c;
          this.pos++;
        }
        if (!closed) {
          this.errorHere('E014', 'unterminated quoted path segment', {
            start: qStart,
            end: this.pos,
          });
          ok = false;
        }
        segments.push(value);
        return;
      }
      const fieldStart = this.pos;
      while (this.pos < this.end && ID_CONT.test(this.peekChar())) this.pos++;
      if (this.pos === fieldStart) {
        this.errorHere('E014', 'expected a path segment', {
          start: fieldStart,
          end: fieldStart + 1,
        });
        ok = false;
        return;
      }
      segments.push(this.text.slice(fieldStart, this.pos));
    };

    const readIndex = (): void => {
      this.pos++; // [
      const negStart = this.pos;
      if (this.peekChar() === '-') this.pos++;
      const digitsStart = this.pos;
      while (this.pos < this.end && /[0-9]/.test(this.peekChar())) this.pos++;
      if (this.pos === digitsStart) {
        this.errorHere('E014', 'expected an array index', { start: negStart, end: this.pos });
        ok = false;
      } else if (this.peekChar() !== ']') {
        this.errorHere('E014', "expected ']'", { start: this.pos, end: this.pos + 1 });
        ok = false;
      } else {
        segments.push(Number(this.text.slice(negStart, this.pos)));
        this.pos++;
      }
    };

    if (this.peekChar() === '[') readIndex();
    else if (this.peekChar() === '.' || this.peekChar() === '"' || ID_CONT.test(this.peekChar())) {
      readField();
    }
    // else: the lone '.' path (root)

    while (ok && this.pos < this.end) {
      const c = this.peekChar();
      if (c === '.') {
        this.pos++;
        readField();
      } else if (c === '[') {
        readIndex();
      } else {
        break;
      }
    }
    const span = { start, end: this.pos };
    this.push({
      kind: 'path',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      segments,
    });
    this.recordSignificant('path');
  }

  /**
   * `%` is ambiguous with the modulo operator. Like `.` (see {@link scanDotOrPath}), it is
   * resolved by lexical context: right after something that completes an expression (so a left
   * operand exists), `%` is modulo; anywhere else it begins a `%name` metadata path.
   */
  private scanPercentOrMetadataPath(): void {
    if (this.lastSignificantKind !== undefined && ATOM_END_KINDS.has(this.lastSignificantKind)) {
      this.emitPunct('%');
      return;
    }
    const start = this.pos;
    this.pos++; // %
    const nameStart = this.pos;
    if (ID_START.test(this.peekChar())) {
      this.pos++;
      while (this.pos < this.end && ID_CONT.test(this.peekChar())) this.pos++;
    }
    const name = this.text.slice(nameStart, this.pos);
    const span = { start, end: this.pos };
    if (name.length === 0) {
      this.diagnostics.push(
        makeDiagnostic({ code: 'E015', message: 'expected a name after `%`', span }),
      );
    }
    this.push({
      kind: 'metadataPath',
      span,
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
      name,
    });
    this.recordSignificant('metadataPath');
  }

  // ---- helpers --------------------------------------------------------------------------------

  private emitPunct(kind: TokenKind, width = 1): void {
    const start = this.pos;
    this.pos += width;
    this.push({
      kind,
      span: { start, end: this.pos },
      text: this.text.slice(start, this.pos),
      precededByNewline: false,
    } as Token);
    this.recordSignificant(kind);
  }

  private emitSimple(kind: TokenKind, start: number, end: number): void {
    this.push({
      kind,
      span: { start, end },
      text: this.text.slice(start, end),
      precededByNewline: false,
    } as Token);
  }

  private errorHere(code: string, message: string, span: Span): void {
    this.diagnostics.push(makeDiagnostic({ code, message, span }));
  }

  private recordSignificant(kind: TokenKind): void {
    this.lastSignificantKind = kind;
  }

  private push(token: Token): void {
    const leading = this.pendingComments;
    this.pendingComments = [];
    this.tokens.push({ token, leadingComments: leading, trailingComment: undefined });
  }
}
