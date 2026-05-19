import { FerruleError } from '@ferrule/core';
import { resolveCoreScalar } from './scalar.js';

/**
 * A small YAML emitter for `LoadedConfig.redactedDump()`. It only needs to handle the plain
 * JavaScript values `nodeToPlain` produces (`null`, `boolean`, `number`, `bigint`, `string`,
 * arrays, and plain objects), and its only correctness requirement is that parsing its output
 * with {@link parseYamlDocument} reproduces the same value — round-tripped exactly, not
 * byte-for-byte identical to whatever produced the original document.
 */

const INDENT = 2;

export interface EmitYamlOptions {
  /** Spaces per indentation level. Default 2. */
  indent?: number;
}

export function emitYaml(value: unknown, options: EmitYamlOptions = {}): string {
  const step = options.indent ?? INDENT;
  const lines = emitBlock(value, 0, step);
  return `${lines.join('\n')}\n`;
}

function emitBlock(value: unknown, indent: number, step: number): string[] {
  if (isPlainObject(value)) return emitMapping(value, indent, step);
  if (Array.isArray(value)) return emitSequence(value, indent, step);
  return [pad(indent) + formatScalar(value)];
}

function emitMapping(obj: Record<string, unknown>, indent: number, step: number): string[] {
  const keys = Object.keys(obj);
  if (keys.length === 0) return [`${pad(indent)}{}`];
  const lines: string[] = [];
  for (const key of keys) {
    const value = obj[key];
    const keyText = formatScalar(key);
    if (isNonEmptyContainer(value)) {
      lines.push(`${pad(indent)}${keyText}:`);
      lines.push(...emitBlock(value, indent + step, step));
    } else if (isPlainObject(value)) {
      lines.push(`${pad(indent)}${keyText}: {}`);
    } else if (Array.isArray(value)) {
      lines.push(`${pad(indent)}${keyText}: []`);
    } else {
      lines.push(`${pad(indent)}${keyText}: ${formatScalar(value)}`);
    }
  }
  return lines;
}

function emitSequence(arr: unknown[], indent: number, step: number): string[] {
  if (arr.length === 0) return [`${pad(indent)}[]`];
  const lines: string[] = [];
  for (const item of arr) {
    if (isNonEmptyContainer(item)) {
      const nested = emitBlock(item, indent + step, step);
      const first = nested[0]!.slice(indent + step);
      lines.push(`${pad(indent)}- ${first}`);
      for (let i = 1; i < nested.length; i++) lines.push(nested[i]!);
    } else if (isPlainObject(item)) {
      lines.push(`${pad(indent)}- {}`);
    } else if (Array.isArray(item)) {
      lines.push(`${pad(indent)}- []`);
    } else {
      lines.push(`${pad(indent)}- ${formatScalar(item)}`);
    }
  }
  return lines;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Array.isArray(value) && value.length > 0;
}

function pad(indent: number): string {
  return ' '.repeat(indent);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return needsQuoting(value) ? quoteDouble(value) : value;
  throw new FerruleError('E_CONFIG_EMIT', `cannot render a ${typeof value} as YAML`);
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return '.nan';
  if (n === Infinity) return '.inf';
  if (n === -Infinity) return '-.inf';
  return String(n);
}

const PLAIN_UNSAFE_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
// eslint-disable-next-line no-control-regex -- deliberately matching control characters to force quoting
const CONTROL_CHARS = /[\n\r\t\x00-\x08\x0b\x0c\x0e-\x1f]/;

/** True if `text` cannot be written as an unquoted plain scalar without changing its meaning. */
function needsQuoting(text: string): boolean {
  if (text === '') return true;
  if (text.trim() !== text) return true;
  if (CONTROL_CHARS.test(text)) return true;
  if (PLAIN_UNSAFE_START.test(text)) return true;
  if (text.includes(': ') || text.endsWith(':') || text.includes(' #')) return true;
  if (text === '---' || text === '...') return true;
  // A plain `<<` key would read back as a merge key.
  if (text === '<<') return true;
  // Anything the core schema would resolve to something other than this exact string (a
  // number, a boolean, null) must be quoted so it reads back as a string.
  return resolveCoreScalar(text) !== text;
}

function quoteDouble(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}
