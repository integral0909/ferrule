import type { Expr, Pattern, Program, Statement, StringPart } from '@ferrule/script';

/**
 * Renders a program (or a single statement/expression/pattern) as a compact S-expression-like
 * string, for golden-style parser tests. Spans are omitted; only shape and literal values are
 * shown.
 */
export function dump(node: Program | Statement | Expr | Pattern): string {
  if (node.kind === 'program') return dumpProgram(node);
  return dumpAny(node);
}

export function dumpProgram(program: Program): string {
  return program.statements.map(dumpStatement).join('\n');
}

function dumpAny(node: Statement | Expr | Pattern): string {
  switch (node.kind) {
    case 'exprStatement':
    case 'let':
    case 'letCapture':
    case 'assign':
    case 'test':
      return dumpStatement(node);
    case 'literalPattern':
    case 'kindPattern':
    case 'regexPattern':
    case 'objectPattern':
    case 'wildcardPattern':
      return dumpPattern(node);
    default:
      return dumpExpr(node);
  }
}

function dumpStatement(node: Statement): string {
  switch (node.kind) {
    case 'exprStatement':
      return dumpExpr(node.expr);
    case 'let':
      return `(let${node.mutable ? '-mut' : ''} ${node.name} ${dumpExpr(node.value)})`;
    case 'letCapture':
      return `(let-capture ${node.valueName} ${node.errName} ${dumpExpr(node.value)})`;
    case 'assign':
      return `(assign ${dumpExpr(node.target)} ${dumpExpr(node.value)})`;
    case 'test':
      return `(test ${JSON.stringify(node.name)} ${dumpExpr(node.given)} ${dumpExpr(node.expect)})`;
  }
}

function dumpStringPart(part: StringPart): string {
  return part.kind === 'text' ? JSON.stringify(part.value) : `$(${dumpExpr(part.expr)})`;
}

function dumpExpr(node: Expr): string {
  switch (node.kind) {
    case 'int':
      return String(node.value);
    case 'float':
      return `${node.value}f`;
    case 'bool':
      return String(node.value);
    case 'null':
      return 'null';
    case 'string':
      return `(str ${node.parts.map(dumpStringPart).join(' ')})`;
    case 'rawString':
      return `(raw ${JSON.stringify(node.value)})`;
    case 'byteString':
      return `(bytes ${[...node.value].join(',')})`;
    case 'timestamp':
      return `(ts ${JSON.stringify(node.text)})`;
    case 'regex':
      return `(regex ${JSON.stringify(node.pattern)} ${JSON.stringify(node.flags)})`;
    case 'path':
      return `(path ${JSON.stringify(node.segments)})`;
    case 'metadataPath':
      return `(meta ${node.name})`;
    case 'identifier':
      return node.name;
    case 'array':
      return `(array ${node.elements.map(dumpExpr).join(' ')})`;
    case 'object':
      return `(object ${node.properties.map((p) => `${p.key}=${dumpExpr(p.value)}`).join(' ')})`;
    case 'unary':
      return `(${node.op} ${dumpExpr(node.operand)})`;
    case 'binary':
      return `(${node.op} ${dumpExpr(node.left)} ${dumpExpr(node.right)})`;
    case 'is':
      return `(is ${dumpExpr(node.subject)} ${node.typeName})`;
    case 'assert':
      return `(assert ${dumpExpr(node.operand)})`;
    case 'index':
      return `(index ${dumpExpr(node.target)} ${dumpExpr(node.index)})`;
    case 'field':
      return `(field ${dumpExpr(node.target)} ${node.name})`;
    case 'call':
      return `(call ${dumpExpr(node.callee)} ${node.args
        .map((a) => (a.kind === 'named' ? `${a.name}:${dumpExpr(a.value)}` : dumpExpr(a.value)))
        .join(' ')})`;
    case 'closure':
      return `(closure (${node.params.map((p) => p.name).join(' ')}) ${dumpExpr(node.body)})`;
    case 'if': {
      const elsePart = node.elseBranch ? ` ${dumpExpr(node.elseBranch)}` : '';
      return `(if ${dumpExpr(node.condition)} ${dumpExpr(node.thenBranch)}${elsePart})`;
    }
    case 'match':
      return `(match ${dumpExpr(node.subject)} ${node.arms
        .map((a) => `[${dumpPattern(a.pattern)} => ${dumpExpr(a.body)}]`)
        .join(' ')})`;
    case 'block': {
      const stmts = node.statements.map(dumpStatement).join(' ');
      const result = node.result ? `-> ${dumpExpr(node.result)}` : '';
      return `(block ${[stmts, result].filter((s) => s.length > 0).join(' ')})`;
    }
    case 'drop':
      return '(drop)';
    case 'abort':
      return `(abort${node.reason ? ` ${dumpExpr(node.reason)}` : ''})`;
    case 'error':
      return '(error)';
  }
}

function dumpPattern(node: Pattern): string {
  switch (node.kind) {
    case 'literalPattern':
      return dumpExpr(node.value);
    case 'kindPattern':
      return `(kind ${node.typeName})`;
    case 'regexPattern':
      return `(regexPat ${JSON.stringify(node.pattern)})`;
    case 'objectPattern':
      return `(objPat ${node.fields
        .map((f) => (f.key === f.binding ? f.key : `${f.key}:${f.binding}`))
        .join(' ')}${node.rest ? ' ..' : ''})`;
    case 'wildcardPattern':
      return '_';
  }
}
