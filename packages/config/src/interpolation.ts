import { FerruleError } from '@ferrule/core';
import { mappingNode, scalarNode, sequenceNode, type DocNode } from './yaml/nodes.js';
import type { SecretBackend, SecretRegistry } from './secrets.js';

/**
 * `${VAR}` / `${VAR:-default}` / `${VAR:?message}` / `$$` / `${secret:NAME}` interpolation of
 * string scalars, applied after parsing (so it works identically for YAML and JSON) and before
 * schema validation.
 *
 * Each `${...}` directive is resolved exactly once and its result is copied verbatim into the
 * output: the scanner never runs a second pass over substituted text, so a secret value (or an
 * environment variable) containing `${...}` cannot trigger further substitution.
 */

export class InterpolationError extends FerruleError {
  constructor(message: string) {
    super('E_CONFIG_INTERPOLATION', message);
    this.name = 'InterpolationError';
  }
}

export interface InterpolationContext {
  /** Environment variables `${VAR}` reads from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Backend for `${secret:NAME}`. `${secret:...}` is an error when this is not set. */
  readonly secretBackend?: SecretBackend;
  readonly secrets: SecretRegistry;
}

const SECRET_DIRECTIVE = /^secret:([A-Za-z0-9_][A-Za-z0-9_.-]*)$/;
const VAR_WITH_DEFAULT = /^([A-Za-z_][A-Za-z0-9_]*):-([\s\S]*)$/;
const VAR_WITH_ERROR = /^([A-Za-z_][A-Za-z0-9_]*):\?([\s\S]*)$/;
const BARE_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Interpolates one string. Used directly by tests; {@link interpolateTree} applies it to a document. */
export async function interpolateString(text: string, ctx: InterpolationContext): Promise<string> {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 0x24 /* $ */) {
      out += text[i];
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (next !== '{') {
      out += '$';
      i++;
      continue;
    }
    const close = text.indexOf('}', i + 2);
    if (close === -1) {
      throw new InterpolationError(`unterminated "\${" in ${JSON.stringify(text)}`);
    }
    const body = text.slice(i + 2, close);
    out += await resolveDirective(body, ctx);
    i = close + 1;
  }
  return out;
}

async function resolveDirective(body: string, ctx: InterpolationContext): Promise<string> {
  const secret = SECRET_DIRECTIVE.exec(body);
  if (secret !== null) {
    const name = secret[1]!;
    if (ctx.secretBackend === undefined) {
      throw new InterpolationError(
        `\${secret:${name}} was used but no secret backend is configured`,
      );
    }
    const value = await ctx.secretBackend.resolve(name);
    if (value === undefined) {
      throw new InterpolationError(`secret ${JSON.stringify(name)} was not found`);
    }
    ctx.secrets.register(value);
    return value;
  }

  const withDefault = VAR_WITH_DEFAULT.exec(body);
  if (withDefault !== null) {
    const [, name, fallback] = withDefault as unknown as [string, string, string];
    const value = ctx.env[name];
    return value !== undefined && value !== '' ? value : fallback;
  }

  const withError = VAR_WITH_ERROR.exec(body);
  if (withError !== null) {
    const [, name, message] = withError as unknown as [string, string, string];
    const value = ctx.env[name];
    if (value === undefined || value === '') {
      throw new InterpolationError(message.length > 0 ? message : `${name} is required`);
    }
    return value;
  }

  if (BARE_VAR.test(body)) return ctx.env[body] ?? '';

  throw new InterpolationError(`invalid interpolation \${${body}}`);
}

/** Interpolates every string scalar in a document tree, preserving structure and source ranges. */
export async function interpolateTree(node: DocNode, ctx: InterpolationContext): Promise<DocNode> {
  if (node.kind === 'scalar') {
    if (typeof node.value !== 'string') return node;
    const value = await interpolateString(node.value, ctx);
    return value === node.value ? node : scalarNode(value, node.style, node.range);
  }
  if (node.kind === 'sequence') {
    const items = await Promise.all(node.items.map((item) => interpolateTree(item, ctx)));
    return sequenceNode(items, node.range);
  }
  const entries = await Promise.all(
    node.entries.map(async (entry) => ({
      key: entry.key,
      value: await interpolateTree(entry.value, ctx),
    })),
  );
  return mappingNode(entries, node.range);
}
