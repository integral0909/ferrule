import type { LoadedConfig } from './loader.js';

/**
 * The difference between two loaded configs, as the runtime needs it for hot reload: which
 * components to start, stop, or replace, and which global settings changed.
 */
export interface ConfigDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  /** Names of global setting groups that differ (`data_dir`, `acknowledgements`, `log`, `api`, `healthchecks`). */
  readonly globalChanged: readonly string[];
}

const GLOBAL_FIELDS = ['dataDir', 'acknowledgements', 'log', 'api', 'healthchecks'] as const;

/** Compares two loaded configs. Component identity is by ID; a kind change counts as a change. */
export function diffConfigs(previous: LoadedConfig, next: LoadedConfig): ConfigDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  const previousIds = new Map(previous.components.map((c) => [c.id, c]));
  const nextIds = new Map(next.components.map((c) => [c.id, c]));

  for (const id of previousIds.keys()) {
    if (!nextIds.has(id)) removed.push(id);
  }
  for (const [id, nextComponent] of nextIds) {
    const prevComponent = previousIds.get(id);
    if (prevComponent === undefined) {
      added.push(id);
      continue;
    }
    const same =
      prevComponent.kind === nextComponent.kind &&
      prevComponent.type === nextComponent.type &&
      deepEqual(prevComponent.options, nextComponent.options) &&
      deepEqual(prevComponent.inputs, nextComponent.inputs) &&
      deepEqual(prevComponent.buffer, nextComponent.buffer);
    if (same) unchanged.push(id);
    else changed.push(id);
  }

  const globalChanged = GLOBAL_FIELDS.filter((field) => !deepEqual(previous[field], next[field]));

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
    globalChanged,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return typeof a === typeof b ? false : String(a) === String(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
