import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogEvent } from '@ferrule/core';
import { compile, parseAndCheck, type ScriptTarget } from '@ferrule/script';
import { describe, expect, it } from 'vitest';

/**
 * Docs drift guard: every ```ferrule fenced code block in the repo's user-facing documentation
 * must actually parse and type-check with zero errors — a snippet that doesn't compile is worse
 * than no snippet at all, since a reader has no way to tell it's stale.
 *
 * Convention, by fence tag:
 *
 * - ```ferrule — a log program (the default target); must check clean.
 * - ```ferrule-metric — a *metric* program; must check clean with `target: 'metric'`. Tagging
 *   these separately is what makes the guard real: checked as a log program, `.buckets` and
 *   `.interval_ms` are just free-form `any` fields and every metric example would pass whether
 *   or not it still matched the metric schema.
 * - ```ferrule-error / ```ferrule-metric-error — documenting a *deliberate* error (e.g. a write
 *   the metric schema rejects); asserted to produce at least one error instead. Use these rather
 *   than leaving a broken example unlabeled.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../../..');

const DOC_FILES = ['README.md', 'docs/language/design.md', 'packages/script/README.md'];

interface FencedBlock {
  readonly file: string;
  readonly lang: string;
  readonly line: number;
  readonly code: string;
}

const FENCE = /^```([\w-]*)\s*$/;

function extractFencedBlocks(file: string, text: string): FencedBlock[] {
  const lines = text.split('\n');
  const blocks: FencedBlock[] = [];
  let open: { lang: string; startLine: number; body: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open === undefined) {
      const m = FENCE.exec(line);
      if (m !== null) open = { lang: m[1]!, startLine: i + 1, body: [] };
      continue;
    }
    if (line === '```') {
      blocks.push({ file, lang: open.lang, line: open.startLine, code: open.body.join('\n') });
      open = undefined;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

function allDocBlocks(): FencedBlock[] {
  return DOC_FILES.flatMap((file) => {
    const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    return extractFencedBlocks(file, text);
  });
}

/** How each recognised fence tag is checked. */
const FENCE_TAGS: Record<
  string,
  { readonly target: ScriptTarget; readonly mustCheckClean: boolean }
> = {
  ferrule: { target: 'log', mustCheckClean: true },
  'ferrule-error': { target: 'log', mustCheckClean: false },
  'ferrule-metric': { target: 'metric', mustCheckClean: true },
  'ferrule-metric-error': { target: 'metric', mustCheckClean: false },
};

function errorsIn(code: string, target: ScriptTarget): string[] {
  const result = parseAndCheck(code, { target });
  return [...result.parseDiagnostics, ...result.diagnostics]
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.code}: ${d.message}`);
}

describe('doc examples: ```ferrule blocks type-check, ```*-error blocks do not', () => {
  const blocks = allDocBlocks().filter((b) => b.lang in FENCE_TAGS);

  // Not vacuous: fail loudly if the extraction itself breaks (e.g. a doc file's fences change
  // shape) rather than silently collecting zero blocks and reporting an empty, "passing" suite.
  it('found at least one ```ferrule block to check', () => {
    expect(blocks.some((b) => b.lang === 'ferrule')).toBe(true);
  });

  // Likewise for the metric examples: the whole point of the separate tag is that these are
  // checked against the metric schema, so silently having none would defeat it.
  it('found at least one ```ferrule-metric block to check', () => {
    expect(blocks.some((b) => b.lang === 'ferrule-metric')).toBe(true);
  });

  for (const block of blocks) {
    const label = `${block.file}:${block.line}`;
    const { target, mustCheckClean } = FENCE_TAGS[block.lang]!;
    if (mustCheckClean) {
      it(`${label} parses and type-checks with zero errors (${target})`, () => {
        expect(errorsIn(block.code, target)).toEqual([]);
      });
    } else {
      it(`${label} (${block.lang}) fails to parse or type-check`, () => {
        expect(errorsIn(block.code, target).length).toBeGreaterThan(0);
      });
    }
  }
});

describe('README headline example: nginx access log parsing, end to end', () => {
  const block = allDocBlocks().find((b) => b.file === 'README.md' && b.lang === 'ferrule');
  if (block === undefined) throw new Error('expected a ```ferrule block in README.md');

  function run(message: string) {
    const checked = parseAndCheck(block!.code);
    const errors = [...checked.parseDiagnostics, ...checked.diagnostics].filter(
      (d) => d.severity === 'error',
    );
    if (errors.length > 0) {
      throw new Error(`README example has errors: ${errors.map((d) => d.message).join('; ')}`);
    }
    const program = compile(checked);
    return program.run(LogEvent.from({ message }));
  }

  it('extracts method/path/status and redacts the client IP from a real nginx combined log line', () => {
    const line =
      '203.0.113.5 - - [10/Oct/2023:13:55:36 +0000] "GET /api/users HTTP/1.1" 200 512 "-" "curl/7.68.0"';
    const outcome = run(line);
    expect(outcome.kind).toBe('continue');
    if (outcome.kind !== 'continue') return;
    const fields = outcome.events[0]!.fields;
    const http = fields.get('http') as Map<string, unknown>;
    expect(http.get('method')).toBe('GET');
    expect(http.get('path')).toBe('/api/users');
    expect(http.get('status')).toBe(200n);
    expect(fields.get('client_ip')).toBe('203.0.113.0');
  });

  it('drops a /healthz request', () => {
    const line =
      '127.0.0.1 - - [10/Oct/2023:13:55:00 +0000] "GET /healthz HTTP/1.1" 200 2 "-" "kube-probe/1.28"';
    expect(run(line).kind).toBe('drop');
  });

  it('redacts a different client IP to its /24 network', () => {
    const line =
      '198.51.100.42 - - [10/Oct/2023:14:00:00 +0000] "POST /api/orders HTTP/1.1" 201 128 "-" "curl/7.68.0"';
    const outcome = run(line);
    expect(outcome.kind).toBe('continue');
    if (outcome.kind !== 'continue') return;
    expect(outcome.events[0]!.fields.get('client_ip')).toBe('198.51.100.0');
  });

  it('aborts on a line that does not match the access-log pattern', () => {
    expect(run('not an nginx log line').kind).toBe('abort');
  });
});
