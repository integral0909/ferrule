import { FerruleError } from '@ferrule/core';
import { REDACTED } from '@ferrule/schema';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * A pluggable source of secret values for `${secret:NAME}` interpolation. Exactly one backend
 * is active for a given config load; which implementation to use is the caller's choice.
 */
export interface SecretBackend {
  readonly name: string;
  /** Resolves `secretName` to its value, or `undefined` if no such secret exists. */
  resolve(secretName: string): Promise<string | undefined>;
}

/** A secret name may contain letters, digits, `_`, `.`, and `-`; nothing that could traverse paths. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Resolves secrets from environment variables, optionally under a common prefix. */
export class EnvSecretBackend implements SecretBackend {
  readonly name = 'env';

  /**
   * @param prefix prepended to the secret name to form the variable name.
   * @param env the environment to read; defaults to `process.env`. Embedders and tests pass their
   *   own so secret resolution sees the same environment as `${VAR}` interpolation.
   */
  constructor(
    private readonly prefix: string = '',
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the SecretBackend contract async uniformly
  async resolve(secretName: string): Promise<string | undefined> {
    return this.env[this.prefix + secretName];
  }
}

/** Resolves secrets from a directory with one file per secret (Docker/Kubernetes secret mount style). */
export class FileSecretBackend implements SecretBackend {
  readonly name = 'file';
  private readonly root: string;

  constructor(directory: string) {
    this.root = path.resolve(directory);
  }

  async resolve(secretName: string): Promise<string | undefined> {
    if (!SECRET_NAME_PATTERN.test(secretName)) {
      throw new FerruleError(
        'E_CONFIG_SECRET_NAME',
        `invalid secret name ${JSON.stringify(secretName)}: must match ${SECRET_NAME_PATTERN.source}`,
      );
    }
    const target = path.resolve(this.root, secretName);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new FerruleError(
        'E_CONFIG_SECRET_PATH',
        `secret name ${JSON.stringify(secretName)} escapes the secrets directory`,
      );
    }
    try {
      const data = await readFile(target, 'utf8');
      return data.replace(/\r?\n$/, '');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

/** Resolves secrets from an in-memory map, for tests and embedding. */
export class MapSecretBackend implements SecretBackend {
  readonly name = 'map';
  private readonly values: ReadonlyMap<string, string>;

  constructor(values: ReadonlyMap<string, string> | Readonly<Record<string, string>>) {
    this.values = values instanceof Map ? values : new Map(Object.entries(values));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the SecretBackend contract async uniformly
  async resolve(secretName: string): Promise<string | undefined> {
    return this.values.get(secretName);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Every secret value resolved while loading a config, so it can be scrubbed from anything shown
 * to a person or written to a log: diagnostics, `redactedDump()`, and (by embedders) their own
 * error messages and internal logs.
 */
export class SecretRegistry {
  private readonly values = new Set<string>();

  register(value: string): void {
    if (value.length > 0) this.values.add(value);
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  get size(): number {
    return this.values.size;
  }

  /** Replaces every occurrence of every registered secret in `text` with a redaction placeholder. */
  redact(text: string): string {
    if (this.values.size === 0) return text;
    // Longest first, so a secret that is a substring of another is not partially redacted.
    const ordered = [...this.values].sort((a, b) => b.length - a.length);
    let out = text;
    for (const secret of ordered) out = out.split(secret).join(REDACTED);
    return out;
  }
}
