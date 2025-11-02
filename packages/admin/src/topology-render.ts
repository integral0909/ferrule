import {
  DEFAULT_PORT,
  parseInputRef,
  type ComponentHealth,
  type TopologySnapshot,
} from '@ferrule/runtime';

const STATE_COLOR: Record<string, string> = {
  starting: '#f9a825',
  running: '#2e7d32',
  stopping: '#ef6c00',
  stopped: '#9e9e9e',
  failed: '#c62828',
};

const SHAPE_BY_KIND: Record<string, string> = {
  source: 'ellipse',
  transform: 'box',
  sink: 'box3d',
};

function stateOf(id: string, health: readonly ComponentHealth[]): string {
  return health.find((h) => h.id === id)?.state ?? 'unknown';
}

/** Escapes backslashes and double quotes in one fragment of DOT text. */
function dotEscapeFragment(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function dotQuote(text: string): string {
  return `"${dotEscapeFragment(text)}"`;
}

/**
 * Renders `snapshot` (a `Pipeline.snapshot()`) as a Graphviz `dot` graph, coloring each node by
 * its current state (from `Pipeline.health()`). Feed the output to `dot -Tsvg` or any Graphviz
 * viewer.
 */
export function renderDot(snapshot: TopologySnapshot, health: readonly ComponentHealth[]): string {
  const lines: string[] = [
    'digraph pipeline {',
    '  rankdir=LR;',
    '  node [fontname="monospace", fontsize=10];',
    '  edge [fontname="monospace", fontsize=9];',
  ];
  for (const component of snapshot.components) {
    const state = stateOf(component.id, health);
    // Each fragment is escaped on its own, then joined with a literal `\n` — Graphviz's own
    // line-break escape inside a label — so that escape sequence survives intact instead of
    // being doubled into a literal backslash by a blanket escape over the whole string.
    const label = [component.id, `${component.type} (${component.kind})`, state]
      .map(dotEscapeFragment)
      .join('\\n');
    const shape = SHAPE_BY_KIND[component.kind] ?? 'box';
    const color = STATE_COLOR[state] ?? '#9e9e9e';
    lines.push(
      `  ${dotQuote(component.id)} [label="${label}", shape=${shape}, style=filled, ` +
        `fillcolor="${color}", fontcolor="white"];`,
    );
  }
  for (const component of snapshot.components) {
    for (const input of component.inputs) {
      const ref = parseInputRef(input);
      const portLabel = ref.port === DEFAULT_PORT ? '' : ` [label=${dotQuote(ref.port)}]`;
      lines.push(`  ${dotQuote(ref.componentId)} -> ${dotQuote(component.id)}${portLabel};`);
    }
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Sanitizes a component ID into a valid Mermaid node identifier (letters, digits, underscore). */
function mermaidId(id: string): string {
  return `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function mermaidEscape(text: string): string {
  return text.replace(/"/g, '&quot;');
}

/** Joins already-escaped fragments with `<br/>`, the line-break markup Mermaid node labels
 * understand — a real newline character would break the flowchart's line-oriented syntax. */
function mermaidLines(fragments: readonly string[]): string {
  return fragments.map(mermaidEscape).join('<br/>');
}

/**
 * Renders `snapshot` as a Mermaid `graph LR` flowchart, with each node's state noted in its
 * label. Suitable for embedding directly in Markdown that a Mermaid renderer processes.
 */
export function renderMermaid(
  snapshot: TopologySnapshot,
  health: readonly ComponentHealth[],
): string {
  const lines: string[] = ['graph LR'];
  for (const component of snapshot.components) {
    const state = stateOf(component.id, health);
    const label = mermaidLines([component.id, `${component.type} (${component.kind})`, state]);
    lines.push(`  ${mermaidId(component.id)}["${label}"]`);
  }
  for (const component of snapshot.components) {
    for (const input of component.inputs) {
      const ref = parseInputRef(input);
      const arrow = ref.port === DEFAULT_PORT ? '-->' : `-->|${mermaidEscape(ref.port)}|`;
      lines.push(`  ${mermaidId(ref.componentId)} ${arrow} ${mermaidId(component.id)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
