import { LimitExceededError, ParseError } from '@ferrule/core';
import { LineIndex, type Range } from '../position.js';
import {
  mappingNode,
  scalarNode,
  sequenceNode,
  type DocNode,
  type MappingEntry,
  type MappingNode,
  type NodeStyle,
  type ScalarNode,
  type SequenceNode,
} from './nodes.js';
import {
  isSupportedTag,
  resolveCoreScalar,
  resolveExplicitTag,
  type ExplicitTag,
  type ScalarValue,
} from './scalar.js';

/**
 * A hand-written parser for the subset of YAML 1.2 real pipeline configs use: block and flow
 * mappings/sequences, plain/quoted/block scalars, comments, anchors/aliases/merge keys, and the
 * core schema's scalar resolution. It composes directly to a {@link DocNode} tree (there is no
 * separate "representation graph" pass); aliases are resolved as they are parsed.
 *
 * Known simplifications, documented rather than silently wrong: plain and quoted scalars are
 * single physical lines (use `|`/`>` block scalars for multi-line text); a bare key/value inside
 * `[...]` without `{...}` is not supported; YAML directives (`%YAML`, `%TAG`) are rejected.
 */

export interface YamlParseOptions {
  /** Maximum nesting depth of block/flow collections. Default 200. */
  maxDepth?: number;
  /** Maximum input length in UTF-16 code units. Default 8 MiB. */
  maxLength?: number;
  /** Maximum number of anchors a document may define. Default 10,000. */
  maxAnchors?: number;
  /** Maximum number of alias references a document may use. Default 10,000. */
  maxAliasUses?: number;
  /**
   * Maximum total "weight" (node count) materialised through alias expansion. Bounds
   * billion-laughs style documents where a handful of anchors, aliased repeatedly and nested,
   * would otherwise blow up combinatorially.
   */
  maxAliasExpansion?: number;
}

const DEFAULTS: Required<YamlParseOptions> = {
  maxDepth: 200,
  maxLength: 8 * 1024 * 1024,
  maxAnchors: 10_000,
  maxAliasUses: 10_000,
  maxAliasExpansion: 200_000,
};

/** Raised for malformed YAML. Carries the 1-based line and column of the problem. */
export class YamlSyntaxError extends ParseError {
  readonly line: number;
  readonly column: number;

  constructor(code: string, message: string, offset: number, li: LineIndex) {
    const { line, column } = li.positionAt(offset);
    super(code, `${message} at line ${line}, column ${column}`, offset);
    this.name = 'YamlSyntaxError';
    this.line = line;
    this.column = column;
  }
}

/** Parses `text` as a single YAML document and returns its composed node tree. */
export function parseYamlDocument(text: string, options: YamlParseOptions = {}): DocNode {
  const opts = { ...DEFAULTS, ...options };
  if (text.length > opts.maxLength) throw new LimitExceededError('yaml.length', opts.maxLength);
  return new YamlParser(text, opts).parseDocument();
}

interface IndentInfo {
  readonly indent: number;
  readonly contentOffset: number;
  readonly tab: boolean;
  readonly blank: boolean;
  readonly commentOnly: boolean;
  readonly lineEnd: number;
}

interface AnchorEntry {
  readonly node: DocNode;
  readonly weight: number;
}

const CH = {
  space: 0x20,
  tab: 0x09,
  cr: 0x0d,
  lf: 0x0a,
  hash: 0x23,
  colon: 0x3a,
  dash: 0x2d,
  amp: 0x26,
  star: 0x2a,
  bang: 0x21,
  singleQuote: 0x27,
  doubleQuote: 0x22,
  braceOpen: 0x7b,
  braceClose: 0x7d,
  bracketOpen: 0x5b,
  bracketClose: 0x5d,
  comma: 0x2c,
  pipe: 0x7c,
  gt: 0x3e,
  plus: 0x2b,
  backslash: 0x5c,
} as const;

class YamlParser {
  private readonly len: number;
  private readonly li: LineIndex;
  private pos = 0;
  private depth = 0;
  private anchorDefCount = 0;
  private aliasUses = 0;
  private aliasWeightUsed = 0;
  private readonly anchors = new Map<string, AnchorEntry>();
  private readonly weightCache = new WeakMap<DocNode, number>();

  constructor(
    private readonly text: string,
    private readonly opts: Required<YamlParseOptions>,
  ) {
    this.len = text.length;
    this.li = new LineIndex(text);
  }

  parseDocument(): DocNode {
    this.skipLeadingMarkers();
    this.skipBlankAndCommentLines();
    if (this.pos >= this.len) this.fail('E_YAML_EMPTY', 'document is empty');
    const lineStart = this.lineStartOf(this.pos);
    const info = this.scanIndent(lineStart);
    this.checkTab(info, lineStart);
    this.pos = info.contentOffset;
    const root = this.parseValue(info.indent);
    this.skipBlankAndCommentLines();
    this.consumeEndMarkerIfPresent();
    this.skipBlankAndCommentLines();
    if (this.pos < this.len) {
      if (this.text.startsWith('---', this.pos)) {
        this.fail(
          'E_YAML_MULTI_DOCUMENT',
          'multiple YAML documents are not supported; found a second document start',
        );
      }
      this.fail('E_YAML_SYNTAX', 'unexpected trailing content after document');
    }
    return root;
  }

  // -- Value dispatch -----------------------------------------------------------------------

  /**
   * Parses one node. `pos` may be at the start of a fresh line or mid-line (right after `key: `
   * or `- `); both are handled uniformly, including the "compact" forms `- key: value` and
   * `- - nested`. Postcondition: `pos` is at the start of the next unconsumed line, or EOF.
   */
  private parseValue(indent: number): DocNode {
    this.checkDepth();
    try {
      const prefix = this.parsePrefix();
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.star) {
        if (prefix.anchor !== undefined || prefix.tag !== undefined) {
          this.fail('E_YAML_SYNTAX', 'an alias cannot have an anchor or a tag');
        }
        const node = this.parseAliasRef();
        this.finishLine();
        return node;
      }

      const lineEnd = this.lineEndOf(this.pos);
      if (this.pos >= lineEnd || this.text.charCodeAt(this.pos) === CH.hash) {
        // Nothing follows the anchor/tag prefix on this line: the body (a block collection, or
        // an implicit null) is on the following lines, e.g. `key: &anchor\n  a: 1\n  b: 2`.
        this.pos = this.nextLineStart(lineEnd);
        const found = this.tryParseValue(indent);
        let body: DocNode;
        if (found !== undefined) {
          if (prefix.tag !== undefined) {
            this.fail(
              'E_YAML_SYNTAX',
              `tag !!${prefix.tag} cannot be combined with a value on a following line`,
            );
          }
          body = found;
        } else {
          const point = this.range(this.pos, this.pos);
          const value =
            prefix.tag !== undefined ? this.applyExplicitTag(prefix.tag, '', point) : null;
          body = scalarNode(value, 'plain', point);
        }
        if (prefix.anchor !== undefined) this.registerAnchor(prefix.anchor, body);
        return body;
      }

      let body: DocNode;
      let singleLine = true;
      if (c === CH.braceOpen) {
        body = this.parseFlowMapping();
      } else if (c === CH.bracketOpen) {
        body = this.parseFlowSequence();
      } else if (c === CH.pipe || c === CH.gt) {
        body = this.parseBlockScalar(indent);
        singleLine = false;
      } else if (this.isSequenceDashAt(this.pos)) {
        body = this.parseBlockSequence(this.columnOf(this.pos));
        singleLine = false;
      } else if (this.isMappingEntryAhead(this.pos, lineEnd)) {
        body = this.parseBlockMapping(this.columnOf(this.pos));
        singleLine = false;
      } else if (c === CH.singleQuote) {
        body = this.wrapScalar(this.parseSingleQuoted(), 'single', prefix.tag);
      } else if (c === CH.doubleQuote) {
        body = this.wrapScalar(this.parseDoubleQuoted(), 'double', prefix.tag);
      } else {
        const { text: raw, range } = this.parsePlainScalarLine(this.pos, lineEnd);
        const value =
          prefix.tag !== undefined
            ? this.applyExplicitTag(prefix.tag, raw, range)
            : resolveCoreScalar(raw);
        body = scalarNode(value, 'plain', range);
      }

      if (prefix.tag !== undefined && body.kind !== 'scalar') {
        this.fail('E_YAML_SYNTAX', `tag !!${prefix.tag} cannot be applied to a ${body.kind}`);
      }
      if (prefix.anchor !== undefined) this.registerAnchor(prefix.anchor, body);
      if (singleLine) this.finishLine();
      return body;
    } finally {
      this.depth--;
    }
  }

  /**
   * Used for a mapping value or sequence item with nothing inline: looks at the next line(s),
   * and if one is indented more than `mustExceed`, parses it as the value; otherwise the value
   * is absent (caller substitutes an implicit `null`). Always leaves `pos` at the start of the
   * next line this call did not consume.
   */
  private tryParseValue(mustExceed: number): DocNode | undefined {
    this.skipBlankAndCommentLines();
    if (this.pos >= this.len) return undefined;
    const lineStart = this.lineStartOf(this.pos);
    const info = this.scanIndent(lineStart);
    if (this.isDocumentMarker(info.contentOffset, info.lineEnd)) {
      this.pos = lineStart;
      return undefined;
    }
    this.checkTab(info, lineStart);
    if (info.indent <= mustExceed) {
      this.pos = lineStart;
      return undefined;
    }
    this.pos = info.contentOffset;
    return this.parseValue(info.indent);
  }

  /** True if `[contentOffset, lineEnd)` is exactly a `---` or `...` document marker line. */
  private isDocumentMarker(contentOffset: number, lineEnd: number): boolean {
    const rest = this.text.slice(contentOffset, lineEnd).replace(/\r$/, '');
    return rest === '---' || rest === '...';
  }

  // -- Block mappings and sequences ----------------------------------------------------------

  private parseBlockMapping(indent: number): MappingNode {
    const startOffset = this.pos;
    const entries: MappingEntry[] = [];
    const seen = new Map<string, Range>();
    const mergeSources: DocNode[] = [];
    let first = true;
    for (;;) {
      if (!first) {
        this.skipBlankAndCommentLines();
        if (this.pos >= this.len) break;
        const lineStart = this.lineStartOf(this.pos);
        const info = this.scanIndent(lineStart);
        if (info.indent !== indent || this.isDocumentMarker(info.contentOffset, info.lineEnd)) {
          this.pos = lineStart;
          break;
        }
        this.checkTab(info, lineStart);
        this.pos = info.contentOffset;
      }
      first = false;

      const key = this.parseMappingKey();
      if (this.text.charCodeAt(this.pos) !== CH.colon) {
        this.fail('E_YAML_SYNTAX', "expected ':' after mapping key");
      }
      this.pos++;
      const afterColon = this.pos;
      const lineEnd = this.lineEndOf(this.pos);
      while (this.pos < lineEnd && this.isSpace(this.text.charCodeAt(this.pos))) this.pos++;

      let value: DocNode;
      if (this.pos >= lineEnd || this.text.charCodeAt(this.pos) === CH.hash) {
        this.pos = this.nextLineStart(lineEnd);
        const found = this.tryParseValue(indent);
        value = found ?? scalarNode(null, 'plain', this.range(afterColon, afterColon));
      } else {
        value = this.parseValue(indent);
      }

      const keyText = String(key.value);
      if (keyText === '<<') {
        this.collectMergeSources(value, mergeSources);
        continue;
      }
      const existing = seen.get(keyText);
      if (existing !== undefined) {
        this.failAt(
          'E_YAML_DUPLICATE_KEY',
          `duplicate key ${JSON.stringify(keyText)} (first used at line ${existing.start.line}, column ${existing.start.column})`,
          key.range.start.offset,
        );
      }
      seen.set(keyText, key.range);
      entries.push({ key, value });
    }
    if (mergeSources.length > 0) this.applyMerge(entries, seen, mergeSources);
    return mappingNode(entries, this.range(startOffset, this.pos));
  }

  private parseMappingKey(): ScalarNode {
    const c = this.text.charCodeAt(this.pos);
    if (c === CH.singleQuote) return this.wrapScalar(this.parseSingleQuoted(), 'single', undefined);
    if (c === CH.doubleQuote) return this.wrapScalar(this.parseDoubleQuoted(), 'double', undefined);
    const lineEnd = this.lineEndOf(this.pos);
    const colon = this.findColon(this.pos, lineEnd);
    if (colon === undefined) this.fail('E_YAML_SYNTAX', 'expected a mapping key');
    let end = colon;
    while (end > this.pos && this.isSpace(this.text.charCodeAt(end - 1))) end--;
    if (end === this.pos) this.fail('E_YAML_SYNTAX', 'mapping key must not be empty');
    const range = this.range(this.pos, end);
    const text = this.text.slice(this.pos, end);
    this.pos = colon;
    return scalarNode(resolveCoreScalar(text), 'plain', range);
  }

  private collectMergeSources(value: DocNode, out: DocNode[]): void {
    if (value.kind === 'mapping') {
      out.push(value);
    } else if (value.kind === 'sequence') {
      for (const item of value.items) {
        if (item.kind !== 'mapping') {
          this.failAt(
            'E_YAML_SYNTAX',
            'merge key value must be a mapping or a sequence of mappings',
            item.range.start.offset,
          );
        }
        out.push(item);
      }
    } else {
      this.failAt(
        'E_YAML_SYNTAX',
        'merge key value must be a mapping or a sequence of mappings',
        value.range.start.offset,
      );
    }
  }

  private applyMerge(
    entries: MappingEntry[],
    seen: Map<string, Range>,
    sources: readonly DocNode[],
  ): void {
    for (const source of sources) {
      if (source.kind !== 'mapping') continue;
      for (const entry of source.entries) {
        const keyText = String(entry.key.value);
        if (seen.has(keyText)) continue;
        seen.set(keyText, entry.key.range);
        entries.push(entry);
      }
    }
  }

  private parseBlockSequence(indent: number): SequenceNode {
    const startOffset = this.pos;
    const items: DocNode[] = [];
    let first = true;
    for (;;) {
      if (!first) {
        this.skipBlankAndCommentLines();
        if (this.pos >= this.len) break;
        const lineStart = this.lineStartOf(this.pos);
        const info = this.scanIndent(lineStart);
        if (info.indent !== indent || this.isDocumentMarker(info.contentOffset, info.lineEnd)) {
          this.pos = lineStart;
          break;
        }
        this.checkTab(info, lineStart);
        this.pos = info.contentOffset;
      }
      first = false;

      if (!this.isSequenceDashAt(this.pos)) {
        this.fail('E_YAML_SYNTAX', "expected '-' to introduce a sequence item");
      }
      this.pos++;
      const lineEnd = this.lineEndOf(this.pos);
      while (this.pos < lineEnd && this.isSpace(this.text.charCodeAt(this.pos))) this.pos++;
      const afterDash = this.pos;

      let value: DocNode;
      if (this.pos >= lineEnd || this.text.charCodeAt(this.pos) === CH.hash) {
        this.pos = this.nextLineStart(lineEnd);
        const found = this.tryParseValue(indent);
        value = found ?? scalarNode(null, 'plain', this.range(afterDash, afterDash));
      } else {
        value = this.parseValue(indent);
      }
      items.push(value);
    }
    return sequenceNode(items, this.range(startOffset, this.pos));
  }

  // -- Block scalars --------------------------------------------------------------------------

  private parseBlockScalar(containerIndent: number): ScalarNode {
    const style: NodeStyle = this.text.charCodeAt(this.pos) === CH.pipe ? 'literal' : 'folded';
    const startOffset = this.pos;
    this.pos++;
    let chomp: 'clip' | 'strip' | 'keep' = 'clip';
    let explicitIndent: number | undefined;
    for (let k = 0; k < 2; k++) {
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.dash) {
        chomp = 'strip';
        this.pos++;
      } else if (c === CH.plus) {
        chomp = 'keep';
        this.pos++;
      } else if (c >= 0x31 && c <= 0x39) {
        explicitIndent = c - 0x30;
        this.pos++;
      } else break;
    }
    const headerLineEnd = this.lineEndOf(this.pos);
    let i = this.pos;
    while (i < headerLineEnd && this.isSpace(this.text.charCodeAt(i))) i++;
    if (i < headerLineEnd && this.text.charCodeAt(i) !== CH.hash) {
      this.fail('E_YAML_SYNTAX', 'unexpected content after block scalar header', i);
    }
    this.pos = this.nextLineStart(headerLineEnd);

    let contentIndent = explicitIndent !== undefined ? containerIndent + explicitIndent : undefined;
    const lines: { text: string; blank: boolean }[] = [];
    let trailingBlanks = 0;
    for (;;) {
      if (this.pos >= this.len) break;
      const lineStart = this.pos;
      const info = this.scanIndent(lineStart);
      if (info.blank) {
        lines.push({ text: '', blank: true });
        trailingBlanks++;
        this.pos = this.nextLineStart(info.lineEnd);
        continue;
      }
      if (contentIndent === undefined) {
        if (info.indent <= containerIndent) break;
        contentIndent = info.indent;
      }
      if (info.indent < contentIndent) break;
      if (this.hasTabInRange(lineStart, contentIndent)) {
        this.failAt('E_YAML_TAB_INDENT', 'tabs are not allowed in indentation', lineStart);
      }
      const raw = this.text.slice(lineStart + contentIndent, info.lineEnd).replace(/\r$/, '');
      lines.push({ text: raw, blank: false });
      trailingBlanks = 0;
      this.pos = this.nextLineStart(info.lineEnd);
    }
    const removedBlanks = trailingBlanks;
    while (trailingBlanks > 0 && lines.length > 0) {
      lines.pop();
      trailingBlanks--;
    }
    const body = assembleBlockScalar(lines, style, chomp, removedBlanks);
    return scalarNode(body, style, this.range(startOffset, this.pos));
  }

  private hasTabInRange(lineStart: number, count: number): boolean {
    for (let i = lineStart; i < lineStart + count; i++) {
      if (this.text.charCodeAt(i) === CH.tab) return true;
    }
    return false;
  }

  // -- Flow collections ------------------------------------------------------------------------

  private parseFlowMapping(): MappingNode {
    const start = this.pos;
    this.pos++;
    const entries: MappingEntry[] = [];
    const seen = new Map<string, Range>();
    this.skipFlowWs();
    if (this.text.charCodeAt(this.pos) === CH.braceClose) {
      this.pos++;
      return mappingNode(entries, this.range(start, this.pos));
    }
    for (;;) {
      this.skipFlowWs();
      const prefix = this.parsePrefix();
      let key: ScalarNode;
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.singleQuote) {
        key = this.wrapScalar(this.parseSingleQuoted(), 'single', prefix.tag);
      } else if (c === CH.doubleQuote) {
        key = this.wrapScalar(this.parseDoubleQuoted(), 'double', prefix.tag);
      } else {
        const span = this.parseFlowScalarSpan();
        const value =
          prefix.tag !== undefined
            ? this.applyExplicitTag(prefix.tag, span.text, span.range)
            : resolveCoreScalar(span.text);
        key = scalarNode(value, 'flow', span.range);
      }
      if (prefix.anchor !== undefined) this.registerAnchor(prefix.anchor, key);
      this.skipFlowWs();

      let value: DocNode;
      if (this.text.charCodeAt(this.pos) === CH.colon && this.isFlowColonBoundary(this.pos)) {
        this.pos++;
        this.skipFlowWs();
        value = this.parseFlowValue();
      } else {
        value = scalarNode(null, 'flow', this.range(this.pos, this.pos));
      }

      const keyText = String(key.value);
      const existing = seen.get(keyText);
      if (existing !== undefined) {
        this.failAt(
          'E_YAML_DUPLICATE_KEY',
          `duplicate key ${JSON.stringify(keyText)}`,
          key.range.start.offset,
        );
      }
      seen.set(keyText, key.range);
      entries.push({ key, value });

      this.skipFlowWs();
      const cc = this.text.charCodeAt(this.pos);
      if (cc === CH.comma) {
        this.pos++;
        this.skipFlowWs();
        if (this.text.charCodeAt(this.pos) === CH.braceClose) {
          this.pos++;
          break;
        }
        continue;
      }
      if (cc === CH.braceClose) {
        this.pos++;
        break;
      }
      this.fail('E_YAML_SYNTAX', "expected ',' or '}' in flow mapping");
    }
    return mappingNode(entries, this.range(start, this.pos));
  }

  private parseFlowSequence(): SequenceNode {
    const start = this.pos;
    this.pos++;
    const items: DocNode[] = [];
    this.skipFlowWs();
    if (this.text.charCodeAt(this.pos) === CH.bracketClose) {
      this.pos++;
      return sequenceNode(items, this.range(start, this.pos));
    }
    for (;;) {
      this.skipFlowWs();
      items.push(this.parseFlowValue());
      this.skipFlowWs();
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.comma) {
        this.pos++;
        this.skipFlowWs();
        if (this.text.charCodeAt(this.pos) === CH.bracketClose) {
          this.pos++;
          break;
        }
        continue;
      }
      if (c === CH.bracketClose) {
        this.pos++;
        break;
      }
      this.fail('E_YAML_SYNTAX', "expected ',' or ']' in flow sequence");
    }
    return sequenceNode(items, this.range(start, this.pos));
  }

  private parseFlowValue(): DocNode {
    this.checkDepth();
    try {
      const prefix = this.parsePrefix();
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.star) {
        if (prefix.anchor !== undefined || prefix.tag !== undefined) {
          this.fail('E_YAML_SYNTAX', 'an alias cannot have an anchor or a tag');
        }
        return this.parseAliasRef();
      }
      let body: DocNode;
      if (c === CH.braceOpen) body = this.parseFlowMapping();
      else if (c === CH.bracketOpen) body = this.parseFlowSequence();
      else if (c === CH.singleQuote) {
        body = this.wrapScalar(this.parseSingleQuoted(), 'single', prefix.tag);
      } else if (c === CH.doubleQuote) {
        body = this.wrapScalar(this.parseDoubleQuoted(), 'double', prefix.tag);
      } else {
        const span = this.parseFlowScalarSpan();
        const value =
          prefix.tag !== undefined
            ? this.applyExplicitTag(prefix.tag, span.text, span.range)
            : resolveCoreScalar(span.text);
        body = scalarNode(value, 'flow', span.range);
      }
      if (prefix.tag !== undefined && body.kind !== 'scalar') {
        this.fail('E_YAML_SYNTAX', `tag !!${prefix.tag} cannot be applied to a ${body.kind}`);
      }
      if (prefix.anchor !== undefined) this.registerAnchor(prefix.anchor, body);
      return body;
    } finally {
      this.depth--;
    }
  }

  private parseFlowScalarSpan(): { text: string; range: Range } {
    const start = this.pos;
    let i = this.pos;
    while (i < this.len) {
      const c = this.text.charCodeAt(i);
      if (c === CH.comma || c === CH.braceClose || c === CH.bracketClose || c === CH.lf) break;
      if (c === CH.colon && this.isFlowColonBoundary(i)) break;
      if (c === CH.hash && i > start && this.isSpace(this.text.charCodeAt(i - 1))) break;
      i++;
    }
    let end = i;
    while (end > start && this.isSpace(this.text.charCodeAt(end - 1))) end--;
    if (end === start) this.fail('E_YAML_SYNTAX', 'expected a value', start);
    this.pos = i;
    return { text: this.text.slice(start, end), range: this.range(start, end) };
  }

  private skipFlowWs(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.space || c === CH.tab || c === CH.lf || c === CH.cr) {
        this.pos++;
        continue;
      }
      if (c === CH.hash) {
        this.pos = this.lineEndOf(this.pos);
        continue;
      }
      break;
    }
  }

  private isFlowColonBoundary(pos: number): boolean {
    const next = this.text.charCodeAt(pos + 1);
    if (Number.isNaN(next)) return true;
    return (
      next === CH.space ||
      next === CH.tab ||
      next === CH.lf ||
      next === CH.cr ||
      next === CH.comma ||
      next === CH.braceClose ||
      next === CH.bracketClose
    );
  }

  // -- Scalars -----------------------------------------------------------------------------

  private parsePlainScalarLine(from: number, lineEnd: number): { text: string; range: Range } {
    let end = lineEnd;
    for (let i = from; i < lineEnd; i++) {
      if (
        this.text.charCodeAt(i) === CH.hash &&
        i > from &&
        this.isSpace(this.text.charCodeAt(i - 1))
      ) {
        end = i;
        break;
      }
    }
    let trimEnd = end;
    while (trimEnd > from && this.isSpace(this.text.charCodeAt(trimEnd - 1))) trimEnd--;
    if (trimEnd === from) this.fail('E_YAML_SYNTAX', 'expected a value', from);
    const text = this.text.slice(from, trimEnd);
    const range = this.range(from, trimEnd);
    this.pos = end;
    return { text, range };
  }

  private parseSingleQuoted(): { text: string; range: Range } {
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= this.len) {
        this.failAt('E_YAML_SYNTAX', 'unterminated single-quoted scalar', start);
      }
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.lf) {
        this.failAt('E_YAML_SYNTAX', 'single-quoted scalars must not span multiple lines', start);
      }
      if (c === CH.singleQuote) {
        if (this.text.charCodeAt(this.pos + 1) === CH.singleQuote) {
          out += "'";
          this.pos += 2;
          continue;
        }
        this.pos++;
        break;
      }
      out += this.text[this.pos];
      this.pos++;
    }
    return { text: out, range: this.range(start, this.pos) };
  }

  private parseDoubleQuoted(): { text: string; range: Range } {
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= this.len) {
        this.failAt('E_YAML_SYNTAX', 'unterminated double-quoted scalar', start);
      }
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.lf) {
        this.failAt('E_YAML_SYNTAX', 'double-quoted scalars must not span multiple lines', start);
      }
      if (c === CH.doubleQuote) {
        this.pos++;
        break;
      }
      if (c === CH.backslash) {
        out += this.readEscape();
        continue;
      }
      out += this.text[this.pos];
      this.pos++;
    }
    return { text: out, range: this.range(start, this.pos) };
  }

  private static readonly SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
    '0': '\0',
    a: '\x07',
    b: '\b',
    t: '\t',
    '\t': '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    e: '\x1b',
    ' ': ' ',
    '"': '"',
    '\\': '\\',
    '/': '/',
    N: '\u0085',
    _: ' ',
    L: ' ',
    P: ' ',
  };

  private readEscape(): string {
    const escPos = this.pos;
    this.pos++;
    const e = this.text[this.pos];
    if (e !== undefined && Object.hasOwn(YamlParser.SIMPLE_ESCAPES, e)) {
      this.pos++;
      return YamlParser.SIMPLE_ESCAPES[e]!;
    }
    if (e === 'x') return this.readHexEscape(2, escPos);
    if (e === 'u') return this.readHexEscape(4, escPos);
    if (e === 'U') return this.readHexEscape(8, escPos);
    this.failAt(
      'E_YAML_SYNTAX',
      `invalid escape sequence ${JSON.stringify('\\' + (e ?? ''))}`,
      escPos,
    );
  }

  private readHexEscape(len: number, escPos: number): string {
    this.pos++;
    const hex = this.text.slice(this.pos, this.pos + len);
    if (hex.length < len || !/^[0-9a-fA-F]+$/.test(hex)) {
      this.failAt('E_YAML_SYNTAX', 'invalid unicode escape', escPos);
    }
    this.pos += len;
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      this.failAt('E_YAML_SYNTAX', 'invalid unicode escape: code point out of range', escPos);
    }
  }

  private wrapScalar(
    q: { text: string; range: Range },
    style: NodeStyle,
    tag: ExplicitTag | undefined,
  ): ScalarNode {
    const value = tag !== undefined ? this.applyExplicitTag(tag, q.text, q.range) : q.text;
    return scalarNode(value, style, q.range);
  }

  private applyExplicitTag(tag: ExplicitTag, text: string, range: Range): ScalarValue {
    const r = resolveExplicitTag(tag, text);
    if (!r.ok) this.failAt('E_YAML_SYNTAX', r.message, range.start.offset);
    return r.value;
  }

  // -- Anchors, aliases, tags ------------------------------------------------------------------

  private parsePrefix(): { anchor?: string; tag?: ExplicitTag } {
    let anchor: string | undefined;
    let tag: ExplicitTag | undefined;
    for (;;) {
      this.skipInlineSpaces();
      const c = this.text.charCodeAt(this.pos);
      if (c === CH.amp && anchor === undefined) {
        this.pos++;
        anchor = this.readAnchorName();
      } else if (c === CH.bang && tag === undefined) {
        tag = this.readTag();
      } else break;
    }
    this.skipInlineSpaces();
    const result: { anchor?: string; tag?: ExplicitTag } = {};
    if (anchor !== undefined) result.anchor = anchor;
    if (tag !== undefined) result.tag = tag;
    return result;
  }

  private readAnchorName(): string {
    const start = this.pos;
    while (this.pos < this.len && !this.isNameBoundary(this.text.charCodeAt(this.pos))) this.pos++;
    if (this.pos === start) this.fail('E_YAML_SYNTAX', 'expected an anchor or alias name', start);
    return this.text.slice(start, this.pos);
  }

  private isNameBoundary(c: number): boolean {
    return (
      Number.isNaN(c) ||
      c === CH.space ||
      c === CH.tab ||
      c === CH.lf ||
      c === CH.cr ||
      c === CH.comma ||
      c === CH.bracketOpen ||
      c === CH.bracketClose ||
      c === CH.braceOpen ||
      c === CH.braceClose ||
      c === CH.colon ||
      c === CH.hash
    );
  }

  private readTag(): ExplicitTag {
    const start = this.pos;
    this.pos++;
    if (this.text.charCodeAt(this.pos) !== CH.bang) {
      this.failAt('E_YAML_UNSUPPORTED_TAG', 'only shorthand tags like !!str are supported', start);
    }
    this.pos++;
    const nameStart = this.pos;
    while (this.pos < this.len && !this.isNameBoundary(this.text.charCodeAt(this.pos))) this.pos++;
    const word = this.text.slice(nameStart, this.pos);
    if (!isSupportedTag(word)) {
      this.failAt('E_YAML_UNSUPPORTED_TAG', `unsupported tag !!${word}`, start);
    }
    return word;
  }

  private parseAliasRef(): DocNode {
    const start = this.pos;
    this.pos++;
    const name = this.readAnchorName();
    const anchor = this.anchors.get(name);
    if (anchor === undefined) {
      this.failAt('E_YAML_UNKNOWN_ANCHOR', `unknown anchor ${JSON.stringify(name)}`, start);
    }
    this.aliasUses++;
    if (this.aliasUses > this.opts.maxAliasUses) {
      throw new LimitExceededError('yaml.aliasUses', this.opts.maxAliasUses);
    }
    this.aliasWeightUsed += anchor.weight;
    if (this.aliasWeightUsed > this.opts.maxAliasExpansion) {
      throw new LimitExceededError('yaml.aliasExpansion', this.opts.maxAliasExpansion);
    }
    return anchor.node;
  }

  private registerAnchor(name: string, node: DocNode): void {
    this.anchorDefCount++;
    if (this.anchorDefCount > this.opts.maxAnchors) {
      throw new LimitExceededError('yaml.anchors', this.opts.maxAnchors);
    }
    this.anchors.set(name, { node, weight: this.nodeWeight(node) });
  }

  private nodeWeight(node: DocNode): number {
    const cached = this.weightCache.get(node);
    if (cached !== undefined) return cached;
    let weight: number;
    if (node.kind === 'scalar') weight = 1;
    else if (node.kind === 'sequence') {
      weight = 1 + node.items.reduce((sum, item) => sum + this.nodeWeight(item), 0);
    } else {
      weight =
        1 +
        node.entries.reduce(
          (sum, entry) => sum + this.nodeWeight(entry.key) + this.nodeWeight(entry.value),
          0,
        );
    }
    this.weightCache.set(node, weight);
    return weight;
  }

  // -- Low-level scanning ------------------------------------------------------------------

  private isSequenceDashAt(pos: number): boolean {
    if (this.text.charCodeAt(pos) !== CH.dash) return false;
    const next = this.text.charCodeAt(pos + 1);
    return (
      Number.isNaN(next) || next === CH.space || next === CH.tab || next === CH.lf || next === CH.cr
    );
  }

  private isMappingEntryAhead(from: number, lineEnd: number): boolean {
    return this.findColon(from, lineEnd) !== undefined;
  }

  /**
   * Finds the colon that would make `[from, lineEnd)` a mapping entry, skipping over quoted
   * spans so a quoted key like `"a: b": 1` is not confused by the colon inside its quotes.
   */
  private findColon(from: number, lineEnd: number): number | undefined {
    let i = from;
    while (i < lineEnd) {
      const c = this.text.charCodeAt(i);
      // A quote only starts a quoted span at the very beginning of the scanned text (i.e. the
      // key/value itself is quoted); a quote appearing mid-plain-scalar is just a character.
      if (i === from && (c === CH.singleQuote || c === CH.doubleQuote)) {
        i = this.skipQuotedSpanForScan(i, lineEnd);
        continue;
      }
      if (c === CH.hash && (i === from || this.isSpace(this.text.charCodeAt(i - 1)))) {
        return undefined;
      }
      if (c === CH.colon) {
        const next = i + 1 < lineEnd ? this.text.charCodeAt(i + 1) : NaN;
        if (Number.isNaN(next) || this.isSpace(next)) return i;
      }
      i++;
    }
    return undefined;
  }

  /** A lightweight, non-validating scan past a quoted span, for {@link findColon} only. */
  private skipQuotedSpanForScan(i: number, lineEnd: number): number {
    const quote = this.text.charCodeAt(i);
    let j = i + 1;
    if (quote === CH.singleQuote) {
      while (j < lineEnd) {
        if (this.text.charCodeAt(j) === CH.singleQuote) {
          if (this.text.charCodeAt(j + 1) === CH.singleQuote) {
            j += 2;
            continue;
          }
          return j + 1;
        }
        j++;
      }
      return lineEnd;
    }
    while (j < lineEnd) {
      const c = this.text.charCodeAt(j);
      if (c === CH.backslash) {
        j += 2;
        continue;
      }
      if (c === CH.doubleQuote) return j + 1;
      j++;
    }
    return lineEnd;
  }

  private isSpace(c: number): boolean {
    // `\r` is included so a trailing CRLF terminator never becomes part of a scanned token: it
    // behaves like trailing whitespace everywhere a line's content is trimmed or bounded.
    return c === CH.space || c === CH.tab || c === CH.cr;
  }

  private skipInlineSpaces(): void {
    while (this.isSpace(this.text.charCodeAt(this.pos))) this.pos++;
  }

  private finishLine(): void {
    const lineEnd = this.lineEndOf(this.pos);
    let i = this.pos;
    while (i < lineEnd && this.isSpace(this.text.charCodeAt(i))) i++;
    if (i < lineEnd && this.text.charCodeAt(i) !== CH.hash) {
      this.fail('E_YAML_SYNTAX', 'unexpected trailing content', i);
    }
    this.pos = this.nextLineStart(lineEnd);
  }

  private skipBlankAndCommentLines(): void {
    for (;;) {
      if (this.pos >= this.len) return;
      const lineStart = this.pos;
      const info = this.scanIndent(lineStart);
      if (info.blank) {
        this.pos = this.nextLineStart(info.lineEnd);
        continue;
      }
      if (info.commentOnly) {
        this.checkTab(info, lineStart);
        this.pos = this.nextLineStart(info.lineEnd);
        continue;
      }
      return;
    }
  }

  private skipLeadingMarkers(): void {
    this.skipBlankAndCommentLines();
    if (this.pos >= this.len) return;
    const lineEnd = this.lineEndOf(this.pos);
    const content = this.text.slice(this.pos, lineEnd).replace(/\r$/, '');
    if (content.startsWith('%')) {
      this.fail('E_YAML_UNSUPPORTED', 'YAML directives are not supported', this.pos);
    }
    if (content === '---') {
      this.pos = this.nextLineStart(lineEnd);
      return;
    }
    if (content.startsWith('--- ') || content.startsWith('---\t')) {
      this.pos += 4;
      this.skipInlineSpaces();
    }
  }

  private consumeEndMarkerIfPresent(): void {
    if (this.pos >= this.len) return;
    const lineEnd = this.lineEndOf(this.pos);
    const content = this.text.slice(this.pos, lineEnd).replace(/\r$/, '');
    if (content === '...') this.pos = this.nextLineStart(lineEnd);
  }

  private scanIndent(lineStart: number): IndentInfo {
    let i = lineStart;
    let tab = false;
    while (i < this.len) {
      const c = this.text.charCodeAt(i);
      if (c === CH.space) {
        i++;
        continue;
      }
      if (c === CH.tab) {
        tab = true;
        i++;
        continue;
      }
      break;
    }
    const lineEnd = this.lineEndOf(lineStart);
    const rest = this.text.slice(i, lineEnd).replace(/\r$/, '');
    const blank = rest === '';
    const commentOnly = !blank && rest.charCodeAt(0) === CH.hash;
    return { indent: i - lineStart, contentOffset: i, tab, blank, commentOnly, lineEnd };
  }

  private checkTab(info: IndentInfo, lineStart: number): void {
    if (info.tab && !info.blank) {
      this.failAt('E_YAML_TAB_INDENT', 'tabs are not allowed in indentation', lineStart);
    }
  }

  private checkDepth(): void {
    this.depth++;
    if (this.depth > this.opts.maxDepth) {
      throw new LimitExceededError('yaml.depth', this.opts.maxDepth);
    }
  }

  private lineStartOf(offset: number): number {
    const i = this.text.lastIndexOf('\n', offset - 1);
    return i === -1 ? 0 : i + 1;
  }

  private lineEndOf(offset: number): number {
    const i = this.text.indexOf('\n', offset);
    return i === -1 ? this.len : i;
  }

  private nextLineStart(lineEndOffset: number): number {
    return lineEndOffset >= this.len ? this.len : lineEndOffset + 1;
  }

  private columnOf(offset: number): number {
    return offset - this.lineStartOf(offset);
  }

  private range(start: number, end: number): Range {
    return this.li.rangeAt(start, end);
  }

  private fail(code: string, message: string, at: number = this.pos): never {
    throw new YamlSyntaxError(code, message, at, this.li);
  }

  private failAt(code: string, message: string, at: number): never {
    throw new YamlSyntaxError(code, message, at, this.li);
  }
}

function assembleBlockScalar(
  lines: readonly { text: string; blank: boolean }[],
  style: 'literal' | 'folded',
  chomp: 'clip' | 'strip' | 'keep',
  trailingBlanks: number,
): string {
  if (lines.length === 0) return '';
  let core: string;
  if (style === 'literal') {
    core = lines.map((l) => l.text).join('\n');
  } else {
    const parts: string[] = [];
    let prevBlank = true;
    for (const l of lines) {
      if (l.blank) {
        parts.push('\n');
        prevBlank = true;
      } else {
        parts.push((prevBlank ? '' : ' ') + l.text);
        prevBlank = false;
      }
    }
    core = parts.join('');
  }
  if (chomp === 'strip') return core;
  if (chomp === 'keep') return core + '\n'.repeat(trailingBlanks + 1);
  return core + '\n';
}
