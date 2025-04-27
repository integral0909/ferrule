import { formatFloat } from '@ferrule/core';
import type { CommentTrivia } from '../syntax/lexer.js';
import { parse } from '../syntax/parser.js';
import { SourceFile } from '../syntax/source.js';
import type {
  Argument,
  BinaryOp,
  BlockExpr,
  Expr,
  IfExpr,
  MatchArm,
  ObjectLiteral,
  ObjectProperty,
  Pattern,
  Program,
  Statement,
  StringPart,
  Trivia,
} from '../syntax/ast.js';

const INDENT = '  ';

/**
 * Formats Ferrule Script source into its canonical form. Idempotent: `format(format(x)) ===
 * format(x)`, and parsing the result yields a structurally equivalent program to parsing `x`
 * (ignoring spans). Comments are preserved where the grammar attaches them as trivia — before a
 * statement, an object property, or a match arm, and trailing on the same line — but a comment in
 * the middle of an expression (e.g. between call arguments) is not, since the AST has nowhere to
 * anchor it; this is a known limitation, not a correctness bug (the parser still accepts and
 * discards such comments without error).
 */
export function format(source: string): string {
  const { program } = parse(new SourceFile('<format>', source));
  return formatProgram(program);
}

export function formatProgram(program: Program): string {
  const printer = new Printer();
  printer.statements(program.statements);
  printer.trailingComments(program.trailingComments);
  return printer.finish();
}

class Printer {
  private readonly lines: string[] = [];
  private level: number;

  constructor(level = 0) {
    this.level = level;
  }

  finish(): string {
    // Exactly one trailing newline, no trailing blank lines.
    while (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') this.lines.pop();
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }

  private emit(text: string): void {
    this.lines.push(text.length === 0 ? '' : `${INDENT.repeat(this.level)}${text}`);
  }

  private blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
  }

  private leading(trivia: Trivia): void {
    trivia.leadingComments.forEach((c, i) => {
      if (i === 0 && c.blankLineBefore) this.blank();
      this.emit(`# ${c.text}`.trimEnd());
    });
  }

  private trailingSuffix(trivia: Trivia): string {
    return trivia.trailingComment ? `  # ${trivia.trailingComment.text}`.trimEnd() : '';
  }

  trailingComments(comments: readonly CommentTrivia[]): void {
    comments.forEach((c, i) => {
      if (i === 0 && c.blankLineBefore) this.blank();
      this.emit(`# ${c.text}`.trimEnd());
    });
  }

  statements(statements: readonly Statement[]): void {
    statements.forEach((stmt) => this.statement(stmt));
  }

  private statement(stmt: Statement): void {
    this.leading(stmt.trivia);
    const suffix = this.trailingSuffix(stmt.trivia);
    switch (stmt.kind) {
      case 'exprStatement':
        this.emit(formatExpr(stmt.expr, 0, this.level) + suffix);
        return;
      case 'let':
        this.emit(
          `let ${stmt.mutable ? 'mut ' : ''}${stmt.name} = ${formatExpr(stmt.value, 0, this.level)}${suffix}`,
        );
        return;
      case 'letCapture':
        this.emit(
          `let ${stmt.valueName}, ${stmt.errName} = ${formatExpr(stmt.value, 0, this.level)}${suffix}`,
        );
        return;
      case 'assign':
        this.emit(
          `${formatExpr(stmt.target, 0, this.level)} = ${formatExpr(stmt.value, 0, this.level)}${suffix}`,
        );
        return;
      case 'test':
        this.testDecl(stmt);
        return;
    }
  }

  private testDecl(stmt: Extract<Statement, { kind: 'test' }>): void {
    this.emit(`test ${JSON.stringify(stmt.name)} {`);
    this.level++;
    this.emit(`given ${formatObjectLiteral(stmt.given, this.level)}`);
    this.emit(`expect ${formatObjectLiteral(stmt.expect, this.level)}`);
    this.level--;
    this.emit('}');
  }

  block(block: BlockExpr): void {
    block.statements.forEach((stmt) => this.statement(stmt));
    if (block.result !== undefined) this.emit(formatExpr(block.result, 0, this.level));
    this.trailingComments(block.trailingComments);
  }
}

function formatObjectLiteral(obj: ObjectLiteral, level: number): string {
  if (obj.properties.length === 0) return '{}';
  const lines: string[] = ['{'];
  const inner = level + 1;
  for (const prop of obj.properties) {
    lines.push(...formatObjectProperty(prop, inner));
  }
  lines.push(`${INDENT.repeat(level)}}`);
  return lines.join('\n');
}

function formatObjectProperty(prop: ObjectProperty, level: number): string[] {
  const lines: string[] = [];
  prop.trivia.leadingComments.forEach((c, i) => {
    if (i === 0 && c.blankLineBefore) lines.push('');
    lines.push(`${INDENT.repeat(level)}# ${c.text}`.trimEnd());
  });
  const suffix = prop.trivia.trailingComment
    ? `  # ${prop.trivia.trailingComment.text}`.trimEnd()
    : '';
  lines.push(
    `${INDENT.repeat(level)}${JSON.stringify(prop.key)}: ${formatExpr(prop.value, 0, level)},${suffix}`,
  );
  return lines;
}

// ---- precedence-aware expression printing ------------------------------------------------------

const BINARY_PREC: Record<BinaryOp, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};
const IS_PREC = 4;
const UNARY_PREC = 7;
const ATOMIC_PREC = 8;

function ownPrecedence(expr: Expr): number {
  if (expr.kind === 'binary') return BINARY_PREC[expr.op];
  if (expr.kind === 'is') return IS_PREC;
  if (expr.kind === 'unary') return UNARY_PREC;
  return ATOMIC_PREC;
}

function formatExpr(expr: Expr, minPrec: number, level: number): string {
  const text = formatExprInner(expr, level);
  return ownPrecedence(expr) < minPrec ? `(${text})` : text;
}

function formatExprInner(expr: Expr, level: number): string {
  switch (expr.kind) {
    case 'int':
      return expr.value.toString();
    case 'float':
      return formatFloat(expr.value);
    case 'bool':
      return String(expr.value);
    case 'null':
      return 'null';
    case 'string':
      return formatStringLiteral(expr.parts, level);
    case 'rawString':
      return `r'${expr.value}'`;
    case 'byteString':
      return `b"${formatByteStringContent(expr.value)}"`;
    case 'timestamp':
      return `t'${expr.text}'`;
    case 'regex':
      return `r/${expr.pattern}/${expr.flags}`;
    case 'path':
      return formatPathSegments(expr.segments);
    case 'metadataPath':
      return `%${expr.name}`;
    case 'identifier':
      return expr.name;
    case 'array':
      return `[${expr.elements.map((e) => formatExpr(e, 0, level)).join(', ')}]`;
    case 'object':
      return formatObjectLiteral(expr, level);
    case 'unary':
      return `${expr.op}${formatExpr(expr.operand, UNARY_PREC, level)}`;
    case 'binary': {
      const prec = BINARY_PREC[expr.op];
      const left = formatExpr(expr.left, prec, level);
      const right = formatExpr(expr.right, prec + 1, level);
      return `${left} ${expr.op} ${right}`;
    }
    case 'is':
      return `${formatExpr(expr.subject, IS_PREC + 1, level)} is ${expr.typeName}`;
    case 'assert':
      return `${formatExpr(expr.operand, ATOMIC_PREC, level)}!`;
    case 'index':
      return `${formatExpr(expr.target, ATOMIC_PREC, level)}[${formatExpr(expr.index, 0, level)}]`;
    case 'field':
      return `${formatExpr(expr.target, ATOMIC_PREC, level)}.${expr.name}`;
    case 'call':
      return `${formatExpr(expr.callee, ATOMIC_PREC, level)}(${formatArgs(expr.args, level)})`;
    case 'closure':
      return formatClosure(expr, level);
    case 'if':
      return formatIf(expr, level);
    case 'match':
      return formatMatch(expr, level);
    case 'block':
      return formatBlockExpr(expr, level);
    case 'drop':
      return 'drop';
    case 'abort':
      return expr.reason === undefined
        ? 'abort'
        : `abort ${formatExpr(expr.reason, ATOMIC_PREC, level)}`;
    case 'error':
      return '/* error */';
  }
}

function formatArgs(args: readonly Argument[], level: number): string {
  return args
    .map((a) =>
      a.kind === 'named'
        ? `${a.name}: ${formatExpr(a.value, 0, level)}`
        : formatExpr(a.value, 0, level),
    )
    .join(', ');
}

function formatClosure(expr: Extract<Expr, { kind: 'closure' }>, level: number): string {
  const params = expr.params.map((p) => p.name).join(', ');
  if (expr.body.kind === 'block') return `|${params}| ${formatBlockExpr(expr.body, level)}`;
  return `|${params}| ${formatExpr(expr.body, 0, level)}`;
}

function formatBlockExpr(block: BlockExpr, level: number): string {
  if (
    block.statements.length === 0 &&
    block.result === undefined &&
    block.trailingComments.length === 0
  ) {
    return '{}';
  }
  const printer = new Printer(level + 1);
  printer.block(block);
  const body = printer.finish();
  const trimmed = body.length > 0 ? body.slice(0, -1) : body; // drop finish()'s trailing \n
  return `{\n${trimmed}\n${INDENT.repeat(level)}}`;
}

function formatIf(expr: IfExpr, level: number): string {
  let text = `if ${formatExpr(expr.condition, 0, level)} ${formatBlockExpr(expr.thenBranch, level)}`;
  if (expr.elseBranch !== undefined) {
    text +=
      expr.elseBranch.kind === 'if'
        ? ` else ${formatIf(expr.elseBranch, level)}`
        : ` else ${formatBlockExpr(expr.elseBranch, level)}`;
  }
  return text;
}

function formatMatch(expr: Extract<Expr, { kind: 'match' }>, level: number): string {
  const lines: string[] = [`match ${formatExpr(expr.subject, 0, level)} {`];
  const inner = level + 1;
  for (const arm of expr.arms) {
    lines.push(...formatMatchArm(arm, inner));
  }
  lines.push(`${INDENT.repeat(level)}}`);
  return lines.join('\n');
}

function formatMatchArm(arm: MatchArm, level: number): string[] {
  const lines: string[] = [];
  arm.trivia.leadingComments.forEach((c, i) => {
    if (i === 0 && c.blankLineBefore) lines.push('');
    lines.push(`${INDENT.repeat(level)}# ${c.text}`.trimEnd());
  });
  const suffix = arm.trivia.trailingComment
    ? `  # ${arm.trivia.trailingComment.text}`.trimEnd()
    : '';
  const body = formatExpr(arm.body, 0, level);
  lines.push(`${INDENT.repeat(level)}${formatPattern(arm.pattern, level)} => ${body},${suffix}`);
  return lines;
}

function formatPattern(pattern: Pattern, level: number): string {
  switch (pattern.kind) {
    case 'literalPattern':
      return formatExpr(pattern.value, 0, level);
    case 'kindPattern':
      return pattern.typeName;
    case 'regexPattern':
      return `r/${pattern.pattern}/${pattern.flags}`;
    case 'objectPattern': {
      const fields = pattern.fields.map((f) =>
        f.key === f.binding ? f.key : `${f.key}: ${f.binding}`,
      );
      if (pattern.rest) fields.push('_');
      return `{ ${fields.join(', ')} }`;
    }
    case 'wildcardPattern':
      return '_';
  }
}

function formatPathSegments(segments: readonly (string | number)[]): string {
  if (segments.length === 0) return '.';
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) out += `.${segment}`;
    else out += `."${escapeStringContent(segment)}"`;
  }
  return out;
}

function formatStringLiteral(parts: readonly StringPart[], level: number): string {
  let out = '"';
  for (const part of parts) {
    out +=
      part.kind === 'text'
        ? escapeStringContent(part.value)
        : `{{ ${formatExpr(part.expr, 0, level)} }}`;
  }
  return `${out}"`;
}

function escapeStringContent(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

function formatByteStringContent(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x09) out += '\\t';
    else if (b === 0x0d) out += '\\r';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}
