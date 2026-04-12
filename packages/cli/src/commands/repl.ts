import { LogEvent, formatValue, parseJson } from '@ferrule/core';
import {
  compile,
  createDefaultImplementations,
  check,
  formatExprType,
  parse,
  renderDiagnostics,
  SourceFile,
  type CompiledProgram,
  type Program,
} from '@ferrule/script';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { withGlobalFlags } from '../args.js';
import { EXIT_OK } from '../exit-codes.js';
import { readLines, write, writeLine } from '../output.js';
import type { Command, CliContext } from '../command.js';

const HELP = [
  'Ferrule Script REPL. Enter a statement or expression and press Enter to run it.',
  'Multi-line input is supported: keep typing while brackets are unbalanced.',
  '',
  'Commands:',
  '  :event {"field": "value"}   set the current event from a JSON object',
  '  :load <file.json>           load the current event from a JSON file',
  '  :type <expr>                show the static type of an expression',
  '  :reset                      reset the current event to {}',
  '  :help                       show this message',
  '  :quit                       exit the REPL',
].join('\n');

const RESULT_FIELD = '____repl_result';

function isBalanced(text: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const ch of text) {
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
    }
  }
  return depth <= 0 && quote === undefined;
}

function isSingleExprStatement(program: Program): boolean {
  return program.statements.length === 1 && program.statements[0]!.kind === 'exprStatement';
}

class ReplSession {
  private currentEvent: LogEvent;

  constructor(private readonly ctx: CliContext) {
    this.currentEvent = new LogEvent();
  }

  async handleCommand(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = line.trim().slice(cmd!.length).trim();
    switch (cmd) {
      case ':help':
        writeLine(this.ctx.env.stdout, HELP);
        return true;
      case ':reset':
        this.currentEvent = new LogEvent();
        writeLine(this.ctx.env.stdout, 'event reset to {}');
        return true;
      case ':event':
        this.setEventFromJson(arg, '<repl:event>');
        return true;
      case ':load':
        await this.loadEventFromFile(rest[0]);
        return true;
      case ':type':
        this.showType(arg);
        return true;
      case ':quit':
      case ':exit':
        return false;
      default:
        writeLine(this.ctx.env.stderr, `unknown command ${JSON.stringify(cmd)}; try :help`);
        return true;
    }
  }

  private setEventFromJson(text: string, name: string): void {
    try {
      const value = parseJson(text);
      if (!(value instanceof Map)) throw new Error('expected a JSON object');
      this.currentEvent = new LogEvent(value);
      writeLine(this.ctx.env.stdout, formatValue(this.currentEvent.fields));
    } catch (error) {
      writeLine(this.ctx.env.stderr, `${name}: ${describe(error)}`);
    }
  }

  private async loadEventFromFile(relative: string | undefined): Promise<void> {
    if (relative === undefined) {
      writeLine(this.ctx.env.stderr, 'usage: :load <file.json>');
      return;
    }
    const path = isAbsolute(relative) ? relative : resolve(this.ctx.env.cwd, relative);
    try {
      const text = await readFile(path, 'utf8');
      this.setEventFromJson(text, relative);
    } catch (error) {
      writeLine(this.ctx.env.stderr, `${relative}: ${describe(error)}`);
    }
  }

  private showType(expr: string): void {
    if (expr.length === 0) {
      writeLine(this.ctx.env.stderr, 'usage: :type <expr>');
      return;
    }
    const file = new SourceFile('<repl:type>', `let __t__ = (\n${expr}\n)`);
    const { program, diagnostics: parseDiagnostics } = parse(file);
    const result = check(program);
    const diagnostics = [...parseDiagnostics, ...result.diagnostics];
    if (diagnostics.some((d) => d.severity === 'error')) {
      write(
        this.ctx.env.stderr,
        `${renderDiagnostics(diagnostics, file, { color: this.ctx.color })}\n`,
      );
      return;
    }
    const stmt = program.statements[0];
    if (stmt === undefined || stmt.kind !== 'let') {
      writeLine(this.ctx.env.stderr, 'could not determine the type of that expression');
      return;
    }
    writeLine(this.ctx.env.stdout, formatExprType(result.typeOf(stmt.value)));
  }

  evaluate(source: string): void {
    const trimmed = source.trim();
    if (trimmed.length === 0) return;

    const probe = parse(new SourceFile('<repl>', trimmed));
    const wrapAsExpression = probe.diagnostics.length === 0 && isSingleExprStatement(probe.program);
    const evalSource = wrapAsExpression ? `.${RESULT_FIELD} = (\n${trimmed}\n)` : trimmed;

    const file = new SourceFile('<repl>', evalSource);
    const { program, diagnostics: parseDiagnostics } = parse(file);
    const checkResult = check(program);
    const diagnostics = [...parseDiagnostics, ...checkResult.diagnostics];
    if (diagnostics.some((d) => d.severity === 'error')) {
      write(
        this.ctx.env.stderr,
        `${renderDiagnostics(diagnostics, file, { color: this.ctx.color })}\n`,
      );
      return;
    }

    let compiled: CompiledProgram;
    try {
      compiled = compile(checkResult, { implementations: createDefaultImplementations() });
    } catch (error) {
      writeLine(this.ctx.env.stderr, `compile error: ${describe(error)}`);
      return;
    }

    const outcome = compiled.run(this.currentEvent.clone());
    if (outcome.kind === 'drop') {
      writeLine(this.ctx.env.stdout, '(dropped)');
      return;
    }
    if (outcome.kind === 'abort') {
      writeLine(this.ctx.env.stdout, `(abort: ${outcome.reason})`);
      return;
    }

    const resultEvent = outcome.events[0]!;
    if (wrapAsExpression) {
      const value = resultEvent.get(`.${RESULT_FIELD}`);
      writeLine(this.ctx.env.stdout, `=> ${value === undefined ? 'null' : formatValue(value)}`);
      resultEvent.remove(`.${RESULT_FIELD}`);
    }
    this.currentEvent = resultEvent;
    writeLine(this.ctx.env.stdout, `event: ${formatValue(this.currentEvent.fields)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const replCommand: Command = {
  spec: withGlobalFlags({
    name: 'repl',
    summary: 'An interactive Ferrule Script REPL.',
    usage: 'ferrule repl',
    flags: [],
  }),

  async run(ctx) {
    const interactive = ctx.env.stdin.isTTY === true;
    if (interactive) {
      writeLine(ctx.env.stdout, 'ferrule repl — type :help for commands, :quit to exit.');
    }
    const session = new ReplSession(ctx);
    let buffer = '';
    const prompt = (): void => {
      if (interactive) write(ctx.env.stdout, buffer.length === 0 ? '> ' : '. ');
    };
    prompt();
    for await (const line of readLines(ctx.env.stdin)) {
      if (buffer.length === 0 && line.trim().startsWith(':')) {
        const keepGoing = await session.handleCommand(line);
        if (!keepGoing) break;
        prompt();
        continue;
      }
      buffer = buffer.length === 0 ? line : `${buffer}\n${line}`;
      if (!isBalanced(buffer)) {
        prompt();
        continue;
      }
      session.evaluate(buffer);
      buffer = '';
      prompt();
    }
    if (interactive) writeLine(ctx.env.stdout, '');
    return EXIT_OK;
  },
};
