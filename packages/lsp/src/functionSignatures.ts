import { formatType, type FunctionParam, type FunctionSignature } from '@ferrule/script';
import type { MarkupContent } from './lspTypes.js';

/** `value`, `count?`, `separator: string = ", "`, or `mapper: |k, v| -> T` for a closure parameter. */
export function formatParam(p: FunctionParam): string {
  if (p.closure !== undefined) {
    const params = p.closure.params.map((cp) => cp.name).join(', ');
    return `${p.name}: |${params}|`;
  }
  const optional = p.optional ? '?' : '';
  const type = formatType(p.type);
  const withDefault = p.defaultDoc !== undefined ? ` = ${p.defaultDoc}` : '';
  return `${p.name}${optional}: ${type}${withDefault}`;
}

/** A one-line call signature, e.g. `replace(value: string, pattern: string, count?: int) -> string`. */
export function formatSignature(sig: FunctionSignature): string {
  const positional = sig.params.filter((p) => !p.namedOnly).map(formatParam);
  const named = sig.params.filter((p) => p.namedOnly).map(formatParam);
  const params = [...positional, ...named].join(', ');
  const returnType = typeof sig.returnType === 'function' ? 'any' : formatType(sig.returnType);
  return `${sig.name}(${params}) -> ${returnType}`;
}

/** Renders full hover/completion documentation for a stdlib function: signature, docs, examples. */
export function formatSignatureMarkdown(sig: FunctionSignature): MarkupContent {
  const lines: string[] = [`\`\`\`ferrule\n${formatSignature(sig)}\n\`\`\``];
  if (sig.docs.length > 0) lines.push(sig.docs);
  if (sig.examples.length > 0) {
    const examples = sig.examples.map((e) => `\`\`\`ferrule\n${e}\n\`\`\``).join('\n\n');
    lines.push(`**Examples:**\n\n${examples}`);
  }
  return { kind: 'markdown', value: lines.join('\n\n') };
}

/** The parameter label to show as "active" in signature help while the cursor is on argument `index`. */
export function paramLabelAt(sig: FunctionSignature, index: number): string | undefined {
  const positional = sig.params.filter((p) => !p.namedOnly);
  return positional[index] === undefined ? undefined : formatParam(positional[index]);
}
