import { readFileSync } from 'node:fs';
import type { LoadedConfig } from '@ferrule/config';
import {
  compile,
  parseAndCheck,
  renderDiagnostics,
  runInlineTests,
  SourceFile,
  type InlineTestResult,
} from '@ferrule/script';

/**
 * Discovers every `script`-typed transform in a loaded pipeline config and runs the `test { ... }`
 * blocks its source contains (`@ferrule/script`'s `runInlineTests`), so `ferrule test` reports
 * inline script tests alongside pipeline test-file cases. This looks for the `type: script`
 * convention `@ferrule/operators`'s `script` transform uses (`source` or `file` options) by name
 * — `@ferrule/testkit` does not depend on `@ferrule/operators`, so it can't check this any other
 * way than by the component's declared `type` string and option shape.
 */

export interface DiscoveredScript {
  readonly componentId: string;
  readonly source: string;
  readonly file: string | undefined;
}

function readScriptSource(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Finds every `type: script` transform in `config`, reading `file`-based sources from disk. */
export function discoverScriptTransforms(config: LoadedConfig): readonly DiscoveredScript[] {
  const found: DiscoveredScript[] = [];
  for (const component of config.transforms.values()) {
    if (component.type !== 'script') continue;
    const options = component.options as { source?: unknown; file?: unknown };
    if (typeof options.source === 'string') {
      found.push({ componentId: component.id, source: options.source, file: undefined });
    } else if (typeof options.file === 'string') {
      found.push({
        componentId: component.id,
        source: readScriptSource(options.file),
        file: options.file,
      });
    }
  }
  return found;
}

export interface InlineScriptTestOutcome {
  readonly componentId: string;
  readonly file: string | undefined;
  /** `undefined` only when the whole script failed to compile (see `compileError`). */
  readonly result: InlineTestResult | undefined;
  /** Set when the script itself did not compile; `result` is `undefined` in that case. */
  readonly compileError: string | undefined;
}

/** Runs every discovered script's inline `test { ... }` blocks. */
export function runInlineScriptTests(
  discovered: readonly DiscoveredScript[],
): readonly InlineScriptTestOutcome[] {
  const outcomes: InlineScriptTestOutcome[] = [];
  for (const script of discovered) {
    const file = new SourceFile(script.file ?? script.componentId, script.source);
    const checked = parseAndCheck(file);
    const errors = [...checked.parseDiagnostics, ...checked.diagnostics].filter(
      (d) => d.severity === 'error',
    );
    if (errors.length > 0) {
      outcomes.push({
        componentId: script.componentId,
        file: script.file,
        result: undefined,
        compileError: renderDiagnostics(errors, file, { color: false }),
      });
      continue;
    }
    const program = compile(checked);
    if (program.tests.length === 0) continue;
    for (const result of runInlineTests(program)) {
      outcomes.push({
        componentId: script.componentId,
        file: script.file,
        result,
        compileError: undefined,
      });
    }
  }
  return outcomes;
}
