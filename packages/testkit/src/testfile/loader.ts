import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FerruleError } from '@ferrule/core';
import {
  ConfigError,
  issueToDiagnostic,
  nodeToPlain,
  parseYamlDocument,
  renderDiagnostics,
  type ConfigDiagnostic,
  type PositionMap,
} from '@ferrule/config';
import { testFileSchema, type TestFile } from './schema.js';

/**
 * Loads and validates one `ferrule test` YAML test file: parses it with `@ferrule/config`'s
 * position-tracking YAML parser, converts it to plain data, and validates it against
 * `testFileSchema`. Reuses `@ferrule/config`'s `ConfigError`/`renderDiagnostics` for reporting,
 * since a malformed test file deserves exactly the same code-frame treatment a malformed
 * pipeline config gets.
 */

export interface LoadedTestFile {
  readonly file: string;
  readonly testFile: TestFile;
  /** Resolved path to the pipeline config `testFile.config` names, relative to `file`'s directory. */
  readonly configPath: string;
  /** Positions of every value in the test file, for locating a failing expectation. */
  readonly positions: PositionMap;
  readonly sourceText: string;
}

async function readFileOrThrow(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new FerruleError(
      'E_TESTKIT_FILE',
      `could not read test file ${JSON.stringify(file)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Loads and validates one test file. Throws `ConfigError` (from `@ferrule/config`) with rendered diagnostics on any problem. */
export async function loadTestFile(file: string): Promise<LoadedTestFile> {
  const text = await readFileOrThrow(file);
  const sources = new Map([[file, text]]);

  let root;
  try {
    root = parseYamlDocument(text);
  } catch (error) {
    throw new ConfigError(
      [
        {
          file,
          range: undefined,
          message: error instanceof Error ? error.message : String(error),
          code: 'E_YAML_PARSE',
        },
      ],
      sources,
    );
  }

  if (root.kind !== 'mapping') {
    throw new ConfigError(
      [
        {
          file,
          range: root.range,
          message: 'the top level of a test file must be a mapping',
          code: 'invalid_type',
        },
      ],
      sources,
    );
  }

  const { value, positions } = nodeToPlain(root, file);
  const result = testFileSchema.safeParse(value);
  if (!result.ok) {
    const diagnostics: ConfigDiagnostic[] = result.issues.map((issue) =>
      issueToDiagnostic(issue, positions),
    );
    throw new ConfigError(diagnostics, sources);
  }

  const testFile = result.value;
  const configPath = resolve(dirname(file), testFile.config);
  return { file, testFile, configPath, positions, sourceText: text };
}

/** Renders a caught error as a human-readable string if it's a `ConfigError`, else its message. */
export function renderLoadError(error: unknown): string {
  if (error instanceof ConfigError) return renderDiagnostics(error.diagnostics, error.sources);
  return error instanceof Error ? error.message : String(error);
}
