import { makeDiagnostic, type Diagnostic, type Fix } from '../diagnostics/diagnostic.js';
import type {
  Argument,
  AssignStatement,
  BinaryOp,
  BlockExpr,
  ClosureParam,
  Expr,
  IfExpr,
  KindPattern,
  LetCaptureStatement,
  LetStatement,
  MatchArm,
  ObjectLiteral,
  ObjectPattern,
  ObjectPatternField,
  ObjectProperty,
  Pattern,
  Program,
  Statement,
  StringPart as AstStringPart,
  TestDecl,
  Trivia,
} from './ast.js';
import type { CommentTrivia, LexedToken } from './lexer.js';
import { lex } from './lexer.js';
import type { Span } from './source.js';
import { joinSpans, type SourceFile } from './source.js';
import type { StringPart as LexStringPart, Token, TokenKind } from './tokens.js';

export interface ParseResult {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
}

/** Parses a full Ferrule Script program. Never throws; errors become diagnostics. */
export function parse(source: SourceFile): ParseResult {
  const { tokens, diagnostics: lexDiagnostics } = lex(source);
  const parser = new Parser(source, tokens);
  const program = parser.parseProgram();
  return { program, diagnostics: [...lexDiagnostics, ...parser.diagnostics] };
}

/** Tokens that can plausibly begin a new statement, used as recovery landmarks. */
const STATEMENT_START_KINDS: ReadonlySet<TokenKind> = new Set([
  'let',
  'drop',
  'abort',
  'test',
  'identifier',
  'path',
  'metadataPath',
  'if',
  'match',
]);

const KIND_PATTERN_NAMES: ReadonlySet<string> = new Set([
  'null',
  'bool',
  'int',
  'float',
  'string',
  'bytes',
  'timestamp',
  'regex',
  'array',
  'object',
]);

class Parser {
  readonly diagnostics: Diagnostic[] = [];
  private readonly source: SourceFile;
  private readonly tokens: readonly LexedToken[];
  private pos = 0;

  constructor(source: SourceFile, tokens: readonly LexedToken[]) {
    this.source = source;
    this.tokens = tokens;
  }

  // ---- token cursor -----------------------------------------------------------------------

  private get current(): Token {
    return this.tokens[this.pos]!.token;
  }

  private currentLexed(): LexedToken {
    return this.tokens[this.pos]!;
  }

  private peekKind(offset = 0): TokenKind {
    const i = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[i]!.token.kind;
  }

  private at(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }

  private advance(): Token {
    const t = this.current;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private skipTerminators(): void {
    while (this.at('newline') || this.at(';')) this.advance();
  }

  /** The comments attached to the *upcoming* token, to become a node's leading comments. */
  private leadingComments(): readonly CommentTrivia[] {
    return this.currentLexed().leadingComments;
  }

  /**
   * Builds a node's final {@link Trivia}: `leading` (captured before the node was parsed) plus
   * the trailing comment on the *last token already consumed* — which only exists once the node
   * is fully parsed, since that token isn't known in advance.
   */
  private buildTrivia(leading: readonly CommentTrivia[]): Trivia {
    const last = this.pos > 0 ? this.tokens[this.pos - 1] : undefined;
    return { leadingComments: leading, trailingComment: last?.trailingComment };
  }

  private expect(kind: TokenKind, code = 'E101', what?: string): Token {
    if (this.at(kind)) return this.advance();
    const label = what ?? describeExpected(kind);
    this.error(code, `expected ${label}, found ${describeToken(this.current)}`);
    return this.current;
  }

  private error(
    code: string,
    message: string,
    span: Span = this.current.span,
    fixes: readonly Fix[] = [],
  ): void {
    this.diagnostics.push(makeDiagnostic({ code, message, span, fixes }));
  }

  /** Skips tokens until a statement boundary, so one error does not cascade. */
  private synchronize(): void {
    while (!this.at('eof')) {
      if (this.at('newline') || this.at(';')) {
        this.advance();
        return;
      }
      if (this.at('}')) return;
      if (STATEMENT_START_KINDS.has(this.current.kind)) return;
      this.advance();
    }
  }

  // ---- program / statements ----------------------------------------------------------------

  parseProgram(): Program {
    const start = this.current.span;
    const statements: Statement[] = [];
    this.skipTerminators();
    while (!this.at('eof')) {
      const before = this.pos;
      const stmt = this.parseStatement();
      if (stmt !== undefined) statements.push(stmt);
      this.skipTerminators();
      // `synchronize` deliberately stops at a `}` without consuming it, so that an enclosing
      // block can match it. At the top level there is no enclosing block, so a stray `}` (e.g.
      // from a value-less object literal like `{"a": }`) would otherwise stall forever; force
      // progress here instead.
      if (this.pos === before) this.advance();
    }
    const trailingComments = this.currentLexed().leadingComments;
    return {
      kind: 'program',
      span: joinSpans(start, this.current.span),
      statements,
      trailingComments,
    };
  }

  /** Parses one statement, or returns `undefined` and synchronizes after reporting an error. */
  private parseStatement(): Statement | undefined {
    const leading = this.leadingComments();
    try {
      if (this.at('let')) return this.parseLet(leading);
      if (this.at('test')) return this.parseTest(leading);
      return this.parseExprOrAssignStatement(leading);
    } catch (e) {
      if (e instanceof ParseBail) {
        this.synchronize();
        return undefined;
      }
      throw e;
    }
  }

  private expectStatementEnd(span: Span): void {
    if (this.at('eof') || this.at('}') || this.at('newline') || this.at(';')) return;
    this.error(
      'E103',
      `expected a newline or ';' to end the statement, found ${describeToken(this.current)}`,
      span,
    );
    this.synchronize();
  }

  private parseLet(leading: readonly CommentTrivia[]): Statement {
    const start = this.advance().span; // 'let'
    let mutable = false;
    if (this.at('mut')) {
      this.advance();
      mutable = true;
    }
    const nameTok = this.expect('identifier', 'E104', 'a variable name');
    const nameSpan = nameTok.span;
    const name = nameTok.text;

    if (this.at(',') && !mutable) {
      this.advance();
      const errTok = this.expect('identifier', 'E104', 'an error-capture variable name');
      this.expect('=');
      const value = this.parseExpr();
      const span = joinSpans(start, value.span);
      this.expectStatementEnd(span);
      const stmt: LetCaptureStatement = {
        kind: 'letCapture',
        span,
        trivia: this.buildTrivia(leading),
        valueName: name,
        valueNameSpan: nameSpan,
        errName: errTok.text,
        errNameSpan: errTok.span,
        value,
      };
      return stmt;
    }

    this.expect('=');
    const value = this.parseExpr();
    const span = joinSpans(start, value.span);
    this.expectStatementEnd(span);
    const stmt: LetStatement = {
      kind: 'let',
      span,
      trivia: this.buildTrivia(leading),
      name,
      nameSpan,
      mutable,
      value,
    };
    return stmt;
  }

  private parseTest(leading: readonly CommentTrivia[]): Statement {
    const start = this.advance().span; // 'test'
    const nameTok = this.expect('string', 'E101', 'a test name string');
    const name = nameTok.kind === 'string' ? stringTextOnly(nameTok.parts) : '';
    this.expect('{');
    this.skipTerminators();
    this.expectKeywordWord('given');
    const given = this.parseObjectLiteralForced();
    this.skipTerminators();
    this.expectKeywordWord('expect');
    const expect = this.parseObjectLiteralForced();
    this.skipTerminators();
    const end = this.expect('}').span;
    const span = joinSpans(start, end);
    this.expectStatementEnd(span);
    const decl: TestDecl = {
      kind: 'test',
      span,
      trivia: this.buildTrivia(leading),
      name,
      nameSpan: nameTok.span,
      given,
      expect,
    };
    return decl;
  }

  private expectKeywordWord(word: 'given' | 'expect'): void {
    if (this.at(word)) {
      this.advance();
      return;
    }
    this.error('E101', `expected '${word}', found ${describeToken(this.current)}`);
    throw new ParseBail();
  }

  private parseExprOrAssignStatement(leading: readonly CommentTrivia[]): Statement {
    const expr = this.parseExpr();
    if (this.at('=')) {
      this.advance();
      const value = this.parseExpr();
      const span = joinSpans(expr.span, value.span);
      if (!isAssignTargetSyntax(expr)) {
        this.error(
          'E108',
          'the left-hand side of `=` must be a path (`.a.b`) or a variable/field/index chain',
          expr.span,
        );
      }
      this.expectStatementEnd(span);
      const stmt: AssignStatement = {
        kind: 'assign',
        span,
        trivia: this.buildTrivia(leading),
        target: expr,
        value,
      };
      return stmt;
    }
    this.expectStatementEnd(expr.span);
    const stmt: Statement = {
      kind: 'exprStatement',
      span: expr.span,
      trivia: this.buildTrivia(leading),
      expr,
    };
    return stmt;
  }

  // ---- blocks -------------------------------------------------------------------------------

  private parseBlockForced(): BlockExpr {
    const start = this.expect('{', 'E109', "'{'").span;
    this.skipTerminators();
    const statements: Statement[] = [];
    let result: Expr | undefined;
    while (!this.at('}') && !this.at('eof')) {
      const before = this.pos;
      const leading = this.leadingComments();
      const checkpoint = this.pos;
      let expr: Expr | undefined;
      try {
        if (this.at('let')) {
          statements.push(this.parseLet(leading));
        } else if (this.at('test')) {
          statements.push(this.parseTest(leading));
        } else {
          expr = this.parseExpr();
          if (this.at('=')) {
            this.pos = checkpoint;
            statements.push(this.parseExprOrAssignStatement(leading));
            expr = undefined;
          }
        }
      } catch (e) {
        if (e instanceof ParseBail) {
          this.synchronize();
        } else {
          throw e;
        }
      }
      if (expr !== undefined) {
        const trivia = this.buildTrivia(leading); // before skipTerminators moves past the trailing comment's token
        this.skipTerminators();
        if (this.at('}')) {
          result = expr;
          break;
        }
        statements.push({ kind: 'exprStatement', span: expr.span, trivia, expr });
      }
      this.skipTerminators();
      if (this.pos === before) this.advance(); // safety net
    }
    const trailingComments = this.currentLexed().leadingComments;
    const end = this.expect('}', 'E109', "'}'").span;
    return {
      kind: 'block',
      span: joinSpans(start, end),
      statements,
      result,
      trailingComments,
    };
  }

  // ---- expressions: precedence climbing ------------------------------------------------------

  parseExpr(): Expr {
    return this.parseCoalesce();
  }

  private parseCoalesce(): Expr {
    return this.parseLeftAssoc(['??'], () => this.parseOr());
  }

  private parseOr(): Expr {
    return this.parseLeftAssoc(['||'], () => this.parseAnd());
  }

  private parseAnd(): Expr {
    return this.parseLeftAssoc(['&&'], () => this.parseComparison());
  }

  private parseLeftAssoc(ops: readonly TokenKind[], next: () => Expr): Expr {
    let left = next();
    while (ops.includes(this.current.kind)) {
      const op = this.advance().kind as BinaryOp;
      this.skipContinuationTerminators();
      const right = next();
      left = { kind: 'binary', span: joinSpans(left.span, right.span), op, left, right };
    }
    return left;
  }

  private skipContinuationTerminators(): void {
    // The lexer already suppresses newlines after binary operators; this is a defensive no-op
    // kept for symmetry and to absorb stray terminators from recovery.
    while (this.at('newline')) this.advance();
  }

  private static readonly COMPARISON_OPS: readonly TokenKind[] = ['==', '!=', '<', '<=', '>', '>='];

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    if (this.at('is')) {
      this.advance();
      const nameTok = this.expect('identifier', 'E104', 'a type name');
      const typeName = nameTok.text;
      if (!KIND_PATTERN_NAMES.has(typeName)) {
        this.error(
          'E101',
          `'${typeName}' is not a known type name; expected one of ${[...KIND_PATTERN_NAMES].join(', ')}`,
          nameTok.span,
        );
      }
      return {
        kind: 'is',
        span: joinSpans(left.span, nameTok.span),
        subject: left,
        typeName,
        typeNameSpan: nameTok.span,
      };
    }
    if (Parser.COMPARISON_OPS.includes(this.current.kind)) {
      const op = this.advance().kind as BinaryOp;
      const right = this.parseAdditive();
      const expr: Expr = {
        kind: 'binary',
        span: joinSpans(left.span, right.span),
        op,
        left,
        right,
      };
      if (Parser.COMPARISON_OPS.includes(this.current.kind)) {
        this.error(
          'E101',
          'comparison operators do not chain; use parentheses to group, e.g. `(a < b) && (b < c)`',
          this.current.span,
        );
      }
      return expr;
    }
    return left;
  }

  private parseAdditive(): Expr {
    return this.parseLeftAssoc(['+', '-'], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Expr {
    return this.parseLeftAssoc(['*', '/', '%'], () => this.parseUnary());
  }

  private parseUnary(): Expr {
    if (this.at('-') || this.at('!')) {
      const opKind = this.current.kind as '-' | '!';
      const opTok = this.advance();
      const operand = this.parseUnary();
      if (opKind === '-' && operand.kind === 'int') {
        // Fold unary minus into the literal so int64::MIN (magnitude 2^63) is representable,
        // and so downstream passes see one literal node rather than unary(-, literal).
        const magnitude = operand.value;
        const MIN_MAGNITUDE = 1n << 63n;
        if (magnitude > MIN_MAGNITUDE) {
          this.error(
            'E005',
            `integer literal -${magnitude} is out of int64 range`,
            joinSpans(opTok.span, operand.span),
          );
        }
        return { kind: 'int', span: joinSpans(opTok.span, operand.span), value: -magnitude };
      }
      return { kind: 'unary', span: joinSpans(opTok.span, operand.span), op: opKind, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at('.')) {
        this.advance();
        const nameTok = this.expect('identifier', 'E104', 'a field name');
        expr = {
          kind: 'field',
          span: joinSpans(expr.span, nameTok.span),
          target: expr,
          name: nameTok.text,
          nameSpan: nameTok.span,
        };
      } else if (this.at('[')) {
        this.advance();
        const index = this.parseExpr();
        const end = this.expect(']').span;
        expr = { kind: 'index', span: joinSpans(expr.span, end), target: expr, index };
      } else if (this.at('(')) {
        expr = this.parseCall(expr);
      } else if (this.at('!')) {
        const bang = this.advance();
        expr = { kind: 'assert', span: joinSpans(expr.span, bang.span), operand: expr };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseCall(callee: Expr): Expr {
    this.advance(); // '('
    const args: Argument[] = [];
    let sawNamed = false;
    while (!this.at(')') && !this.at('eof')) {
      const start = this.pos;
      if (this.at('identifier') && this.peekKind(1) === ':') {
        const nameTok = this.advance();
        this.advance(); // ':'
        const value = this.parseExpr();
        if (args.some((a) => a.kind === 'named' && a.name === nameTok.text)) {
          this.error('E106', `duplicate named argument '${nameTok.text}'`, nameTok.span);
        }
        args.push({
          kind: 'named',
          span: joinSpans(nameTok.span, value.span),
          name: nameTok.text,
          nameSpan: nameTok.span,
          value,
        });
        sawNamed = true;
      } else {
        const value = this.parseExpr();
        if (sawNamed) {
          this.error('E107', 'positional arguments must come before named arguments', value.span);
        }
        args.push({ kind: 'positional', span: value.span, value });
      }
      if (this.at(',')) {
        this.advance();
        this.skipContinuationTerminators();
      } else {
        break;
      }
      if (this.pos === start) break; // safety net
    }
    const end = this.expect(')').span;
    return { kind: 'call', span: joinSpans(callee.span, end), callee, args };
  }

  private parsePrimary(): Expr {
    const t = this.current;
    switch (t.kind) {
      case 'int':
        this.advance();
        if (t.outOfRange) this.error('E005', `integer literal is out of int64 range`, t.span);
        return { kind: 'int', span: t.span, value: t.value };
      case 'float':
        this.advance();
        return { kind: 'float', span: t.span, value: t.value };
      case 'string':
        this.advance();
        return { kind: 'string', span: t.span, parts: this.buildStringParts(t.parts) };
      case 'rawString':
        this.advance();
        return { kind: 'rawString', span: t.span, value: t.value };
      case 'byteString':
        this.advance();
        return { kind: 'byteString', span: t.span, value: t.value };
      case 'timestamp':
        this.advance();
        return { kind: 'timestamp', span: t.span, text: t.value };
      case 'regex':
        this.advance();
        return { kind: 'regex', span: t.span, pattern: t.pattern, flags: t.flags };
      case 'true':
        this.advance();
        return { kind: 'bool', span: t.span, value: true };
      case 'false':
        this.advance();
        return { kind: 'bool', span: t.span, value: false };
      case 'null':
        this.advance();
        return { kind: 'null', span: t.span };
      case 'path':
        this.advance();
        return { kind: 'path', span: t.span, segments: t.segments };
      case 'metadataPath':
        this.advance();
        return { kind: 'metadataPath', span: t.span, name: t.name };
      case 'identifier':
        this.advance();
        return { kind: 'identifier', span: t.span, name: t.text };
      case '(': {
        this.advance();
        this.skipContinuationTerminators();
        const inner = this.parseExpr();
        this.skipContinuationTerminators();
        this.expect(')');
        return inner;
      }
      case '[':
        return this.parseArrayLiteral();
      case '{':
        return this.parseBraceExpr();
      case '|':
        return this.parseClosure();
      case 'if':
        return this.parseIf();
      case 'match':
        return this.parseMatch();
      case 'drop':
        this.advance();
        return { kind: 'drop', span: t.span };
      case 'abort':
        return this.parseAbort();
      default:
        this.error('E102', `expected an expression, found ${describeToken(t)}`);
        throw new ParseBail();
    }
  }

  private buildStringParts(parts: readonly LexStringPart[]): readonly AstStringPart[] {
    return parts.map((p) => {
      if (p.kind === 'text') return { kind: 'text', value: p.value };
      const expr = this.parseSubExpression(p.span);
      return { kind: 'interpolation', span: p.span, expr };
    });
  }

  private parseSubExpression(span: Span): Expr {
    if (span.start >= span.end) {
      this.error('E102', 'expected an expression inside `{{ }}`', span);
      return { kind: 'error', span };
    }
    const { tokens, diagnostics } = lex(this.source, { start: span.start, end: span.end });
    const sub = new Parser(this.source, tokens);
    let expr: Expr;
    try {
      expr = sub.parseExpr();
    } catch (e) {
      if (e instanceof ParseBail) expr = { kind: 'error', span };
      else throw e;
    }
    if (!sub.at('eof')) {
      sub.error('E101', `unexpected ${describeToken(sub.current)} after interpolated expression`);
    }
    this.diagnostics.push(...diagnostics, ...sub.diagnostics);
    return expr;
  }

  private parseArrayLiteral(): Expr {
    const start = this.advance().span; // '['
    this.skipContinuationTerminators();
    const elements: Expr[] = [];
    while (!this.at(']') && !this.at('eof')) {
      elements.push(this.parseExpr());
      this.skipContinuationTerminators();
      if (this.at(',')) {
        this.advance();
        this.skipContinuationTerminators();
      } else {
        break;
      }
    }
    const end = this.expect(']').span;
    return { kind: 'array', span: joinSpans(start, end), elements };
  }

  /** Disambiguates `{ key: value, ... }` (object) from `{ stmt; stmt }` (block). */
  private parseBraceExpr(): Expr {
    if (this.looksLikeObjectLiteral()) return this.parseObjectLiteralForced();
    return this.parseBlockForced();
  }

  /**
   * Looks past the `{` for `key:` (an object literal) vs. anything else (a block). The lexer
   * does not suppress a newline right after `{` — blocks need it as a statement separator — so
   * this scans past any leading newlines rather than assuming the key sits at a fixed offset.
   */
  private looksLikeObjectLiteral(): boolean {
    let i = 1;
    while (this.peekKind(i) === 'newline') i++;
    if (this.peekKind(i) === '}') return true; // `{}` — treat empty braces as an empty object
    const keyKind = this.peekKind(i);
    if (keyKind !== 'identifier' && keyKind !== 'string') return false;
    i++;
    while (this.peekKind(i) === 'newline') i++;
    return this.peekKind(i) === ':';
  }

  private parseObjectLiteralForced(): ObjectLiteral {
    const start = this.expect('{', 'E109', "'{'").span;
    this.skipContinuationTerminators();
    const properties: ObjectProperty[] = [];
    const seen = new Set<string>();
    while (!this.at('}') && !this.at('eof')) {
      const leading = this.leadingComments();
      let key: string;
      let keySpan: Span;
      if (this.at('string')) {
        const tok = this.advance();
        key = tok.kind === 'string' ? stringTextOnly(tok.parts) : '';
        keySpan = tok.span;
      } else {
        const tok = this.expect('identifier', 'E104', 'an object key');
        key = tok.text;
        keySpan = tok.span;
      }
      this.expect(':');
      this.skipContinuationTerminators();
      const value = this.parseExpr();
      if (seen.has(key)) this.error('E110', `duplicate object key '${key}'`, keySpan);
      seen.add(key);
      // A same-line trailing comment attaches to whichever token the lexer saw last — the value
      // itself, or the comma right after it — so the comma (if any) must be consumed *before*
      // `buildTrivia` looks at it.
      const hadComma = this.at(',');
      if (hadComma) this.advance();
      properties.push({
        span: joinSpans(keySpan, value.span),
        key,
        keySpan,
        value,
        trivia: this.buildTrivia(leading),
      });
      this.skipContinuationTerminators();
      if (!hadComma) break;
    }
    const end = this.expect('}', 'E109', "'}'").span;
    return { kind: 'object', span: joinSpans(start, end), properties };
  }

  private parseClosure(): Expr {
    const start = this.advance().span; // '|'
    const params: ClosureParam[] = [];
    while (!this.at('|') && !this.at('eof')) {
      const tok = this.expect('identifier', 'E111', 'a closure parameter name');
      params.push({ name: tok.text, span: tok.span });
      if (this.at(',')) this.advance();
      else break;
    }
    this.expect('|', 'E111', "closing '|'");
    const body = this.at('{') ? this.parseBlockForced() : this.parseExpr();
    return { kind: 'closure', span: joinSpans(start, body.span), params, body };
  }

  private parseIf(): IfExpr {
    const start = this.advance().span; // 'if'
    const condition = this.parseExpr();
    const thenBranch = this.parseBlockForced();
    let elseBranch: BlockExpr | IfExpr | undefined;
    if (this.at('else')) {
      this.advance();
      elseBranch = this.at('if') ? this.parseIf() : this.parseBlockForced();
    }
    const end = elseBranch?.span ?? thenBranch.span;
    return { kind: 'if', span: joinSpans(start, end), condition, thenBranch, elseBranch };
  }

  private parseMatch(): Expr {
    const start = this.advance().span; // 'match'
    const subject = this.parseExpr();
    this.expect('{', 'E109', "'{'");
    this.skipTerminators();
    const arms: MatchArm[] = [];
    while (!this.at('}') && !this.at('eof')) {
      const leading = this.leadingComments();
      const pattern = this.parsePattern();
      if (!this.at('=>')) {
        this.error('E112', `expected '=>', found ${describeToken(this.current)}`);
      } else {
        this.advance();
      }
      this.skipContinuationTerminators();
      const body = this.parseExpr();
      // See the matching comment in `parseObjectLiteralForced`: consume a trailing comma before
      // reading trivia, since a same-line comment may be attached to the comma, not the body.
      if (this.at(',')) this.advance();
      arms.push({
        span: joinSpans(pattern.span, body.span),
        trivia: this.buildTrivia(leading),
        pattern,
        body,
      });
      this.skipTerminators();
    }
    const end = this.expect('}', 'E109', "'}'").span;
    return { kind: 'match', span: joinSpans(start, end), subject, arms };
  }

  private parsePattern(): Pattern {
    const t = this.current;
    if (t.kind === '_') {
      this.advance();
      return { kind: 'wildcardPattern', span: t.span };
    }
    if (t.kind === 'regex') {
      this.advance();
      return { kind: 'regexPattern', span: t.span, pattern: t.pattern, flags: t.flags };
    }
    if (
      t.kind === 'int' ||
      t.kind === 'float' ||
      t.kind === 'string' ||
      t.kind === 'true' ||
      t.kind === 'false' ||
      t.kind === 'null'
    ) {
      const lit = this.parsePrimary();
      if (
        lit.kind === 'int' ||
        lit.kind === 'float' ||
        lit.kind === 'string' ||
        lit.kind === 'bool' ||
        lit.kind === 'null'
      ) {
        return { kind: 'literalPattern', span: lit.span, value: lit };
      }
      this.error('E105', 'expected a literal pattern', lit.span);
      return { kind: 'wildcardPattern', span: lit.span };
    }
    if (t.kind === '-') {
      // A negative literal pattern, e.g. `-1 => ...`.
      const lit = this.parseUnary();
      if (lit.kind === 'int' || lit.kind === 'float') {
        return { kind: 'literalPattern', span: lit.span, value: lit };
      }
      this.error('E105', 'expected a literal pattern', lit.span);
      return { kind: 'wildcardPattern', span: lit.span };
    }
    if (t.kind === 'identifier' && KIND_PATTERN_NAMES.has(t.text)) {
      this.advance();
      const pattern: KindPattern = { kind: 'kindPattern', span: t.span, typeName: t.text };
      return pattern;
    }
    if (t.kind === '{') {
      return this.parseObjectPattern();
    }
    this.error('E105', `expected a pattern, found ${describeToken(t)}`);
    throw new ParseBail();
  }

  private parseObjectPattern(): ObjectPattern {
    const start = this.advance().span; // '{'
    this.skipContinuationTerminators();
    const fields: ObjectPatternField[] = [];
    let rest = false;
    while (!this.at('}') && !this.at('eof')) {
      if (this.at('_')) {
        this.advance();
        rest = true;
        this.skipContinuationTerminators();
        break;
      }
      const keyTok = this.expect('identifier', 'E104', 'an object pattern field name');
      let binding = keyTok.text;
      let bindingSpan = keyTok.span;
      if (this.at(':')) {
        this.advance();
        const bindTok = this.expect('identifier', 'E104', 'a binding name');
        binding = bindTok.text;
        bindingSpan = bindTok.span;
      }
      fields.push({
        span: joinSpans(keyTok.span, bindingSpan),
        key: keyTok.text,
        keySpan: keyTok.span,
        binding,
        bindingSpan,
      });
      this.skipContinuationTerminators();
      if (this.at(',')) {
        this.advance();
        this.skipContinuationTerminators();
      } else {
        break;
      }
    }
    const end = this.expect('}', 'E109', "'}'").span;
    return { kind: 'objectPattern', span: joinSpans(start, end), fields, rest };
  }

  private parseAbort(): Expr {
    const start = this.advance().span; // 'abort'
    if (this.canStartExpr()) {
      const reason = this.parseExpr();
      return { kind: 'abort', span: joinSpans(start, reason.span), reason };
    }
    return { kind: 'abort', span: start, reason: undefined };
  }

  private canStartExpr(): boolean {
    switch (this.current.kind) {
      case 'newline':
      case ';':
      case 'eof':
      case '}':
      case ')':
      case ']':
      case ',':
        return false;
      default:
        return true;
    }
  }
}

/** Thrown internally to unwind to statement-level recovery; never escapes {@link parse}. */
class ParseBail extends Error {}

function isAssignTargetSyntax(expr: Expr): boolean {
  switch (expr.kind) {
    case 'path':
    case 'identifier':
      return true;
    case 'field':
    case 'index':
      return isAssignTargetSyntax(expr.target);
    default:
      return false;
  }
}

function stringTextOnly(parts: readonly LexStringPart[]): string {
  return parts.map((p) => (p.kind === 'text' ? p.value : '')).join('');
}

function describeToken(t: Token): string {
  switch (t.kind) {
    case 'eof':
      return 'end of input';
    case 'newline':
      return 'a newline';
    case 'identifier':
      return `identifier '${t.text}'`;
    case 'int':
    case 'float':
      return `number '${t.text}'`;
    case 'string':
      return 'a string literal';
    case 'error':
      return `unexpected character ${JSON.stringify(t.text)}`;
    default:
      return `'${t.text}'`;
  }
}

function describeExpected(kind: TokenKind): string {
  return `'${kind}'`;
}

// Re-exported for callers that want to parse just an interpolation-style fragment, e.g. tooling.
export function parseExprFragment(
  source: SourceFile,
  span: Span,
): { expr: Expr; diagnostics: readonly Diagnostic[] } {
  const { tokens, diagnostics: lexDiags } = lex(source, { start: span.start, end: span.end });
  const parser = new Parser(source, tokens);
  const expr = parser.parseExpr();
  return { expr, diagnostics: [...lexDiags, ...parser.diagnostics] };
}

export type { CommentTrivia };
