import type { Range, SourceLocation } from '../position.js';
import type { ScalarValue } from './scalar.js';

/**
 * The composed document tree produced by the YAML parser and the JSON reader: a value tree that
 * still carries a source {@link Range} for every scalar, mapping, and sequence, and for every
 * mapping key. Aliases, anchors, and merge keys are already resolved by the time a tree exists;
 * there is no separate representation for them.
 */

export type DocNode = ScalarNode | MappingNode | SequenceNode;

export type NodeStyle = 'plain' | 'single' | 'double' | 'literal' | 'folded' | 'flow';

export interface ScalarNode {
  readonly kind: 'scalar';
  readonly value: ScalarValue;
  readonly style: NodeStyle;
  readonly range: Range;
}

export interface MappingEntry {
  readonly key: ScalarNode;
  readonly value: DocNode;
}

export interface MappingNode {
  readonly kind: 'mapping';
  readonly entries: readonly MappingEntry[];
  readonly range: Range;
}

export interface SequenceNode {
  readonly kind: 'sequence';
  readonly items: readonly DocNode[];
  readonly range: Range;
}

export function scalarNode(value: ScalarValue, style: NodeStyle, range: Range): ScalarNode {
  return { kind: 'scalar', value, style, range };
}

export function mappingNode(entries: readonly MappingEntry[], range: Range): MappingNode {
  return { kind: 'mapping', entries, range };
}

export function sequenceNode(items: readonly DocNode[], range: Range): SequenceNode {
  return { kind: 'sequence', items, range };
}

export type PathSegment = string | number;

interface PositionEntry {
  readonly location: SourceLocation;
  readonly keyLocation?: SourceLocation;
}

/**
 * Maps a config path (the same `(string | number)[]` shape as a schema {@link Issue} path) to
 * where it came from in source. Built while a node tree is converted to plain values, and merged
 * across files by the multi-file loader.
 */
export class PositionMap {
  private readonly entries = new Map<string, PositionEntry>();

  set(path: readonly PathSegment[], entry: PositionEntry): void {
    this.entries.set(pathKey(path), entry);
  }

  get(path: readonly PathSegment[]): PositionEntry | undefined {
    return this.entries.get(pathKey(path));
  }

  /**
   * The location for `path`, falling back to the nearest recorded ancestor when the exact path
   * was never written (e.g. a required key that is missing entirely points at its parent
   * mapping instead of nowhere).
   */
  resolve(path: readonly PathSegment[]): SourceLocation | undefined {
    for (let n = path.length; n >= 0; n--) {
      const entry = this.entries.get(pathKey(path.slice(0, n)));
      if (entry !== undefined) return entry.location;
    }
    return undefined;
  }

  /**
   * Like {@link resolve}, but for issues about a key itself (`required`, `unknown_key`) prefers
   * the range of the key token over the range of its value.
   */
  resolveKey(path: readonly PathSegment[]): SourceLocation | undefined {
    const exact = this.entries.get(pathKey(path));
    if (exact?.keyLocation !== undefined) return exact.keyLocation;
    return this.resolve(path);
  }

  /** Copies every entry from `other` that this map does not already have. */
  merge(other: PositionMap): void {
    for (const [key, entry] of other.entries) {
      if (!this.entries.has(key)) this.entries.set(key, entry);
    }
  }
}

function pathKey(path: readonly PathSegment[]): string {
  return JSON.stringify(path);
}

/** Defines an own property so untrusted keys like `__proto__` are ordinary data, not prototype writes. */
export function defineField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export interface NodeToPlainResult {
  readonly value: unknown;
  readonly positions: PositionMap;
}

/**
 * Converts a composed node tree into a plain JavaScript value suitable for `@ferrule/schema`:
 * mappings become plain objects (never `Map`, never touching the real prototype), sequences
 * become arrays, and scalars become their resolved value. `file` tags every recorded position.
 */
export function nodeToPlain(node: DocNode, file: string): NodeToPlainResult {
  const positions = new PositionMap();
  positions.set([], { location: { file, range: node.range } });
  const value = convert(node, []);
  return { value, positions };

  function convert(n: DocNode, path: readonly PathSegment[]): unknown {
    switch (n.kind) {
      case 'scalar':
        return n.value;
      case 'sequence': {
        const out: unknown[] = [];
        n.items.forEach((item, i) => {
          const childPath = [...path, i];
          positions.set(childPath, { location: { file, range: item.range } });
          out.push(convert(item, childPath));
        });
        return out;
      }
      case 'mapping': {
        const out: Record<string, unknown> = {};
        for (const entry of n.entries) {
          const key = String(entry.key.value);
          const childPath = [...path, key];
          positions.set(childPath, {
            location: { file, range: entry.value.range },
            keyLocation: { file, range: entry.key.range },
          });
          defineField(out, key, convert(entry.value, childPath));
        }
        return out;
      }
    }
  }
}
