import type { ComponentHealth, TopologySnapshot } from '@ferrule/runtime';
import { describe, expect, it } from 'vitest';
import { renderDot, renderMermaid } from '../src/topology-render.js';

const snapshot: TopologySnapshot = {
  components: [
    { id: 'app_logs', kind: 'source', type: 'http', inputs: [] },
    { id: 'shape', kind: 'transform', type: 'script', inputs: ['app_logs', 'app_logs.errors'] },
    { id: 'store', kind: 'sink', type: 'clickhouse', inputs: ['shape'] },
  ],
};

const health: ComponentHealth[] = [
  { id: 'app_logs', kind: 'source', type: 'http', state: 'running' },
  { id: 'shape', kind: 'transform', type: 'script', state: 'running' },
  { id: 'store', kind: 'sink', type: 'clickhouse', state: 'failed', error: 'connection refused' },
];

describe('renderDot', () => {
  it('produces a digraph with one node per component and one edge per input', () => {
    const dot = renderDot(snapshot, health);
    expect(dot.startsWith('digraph pipeline {')).toBe(true);
    expect(dot.trim().endsWith('}')).toBe(true);
    for (const c of snapshot.components) expect(dot).toContain(`"${c.id}"`);
    expect(dot).toContain('"app_logs" -> "shape"');
    expect(dot).toContain('"shape" -> "store"');
  });

  it('labels an edge that comes from a non-default port', () => {
    const dot = renderDot(snapshot, health);
    expect(dot).toContain('"app_logs" -> "shape" [label="errors"]');
  });

  it('colors a node by its current state and includes the state in the label', () => {
    const dot = renderDot(snapshot, health);
    // failed -> red fill, and "failed" appears in the store node's label text.
    expect(dot).toMatch(
      /"store" \[label="store\\nclickhouse \(sink\)\\nfailed", .*fillcolor="#c62828"/,
    );
  });

  it('falls back to shape=box and an "unknown" state for a component missing from health', () => {
    const dot = renderDot(snapshot, []);
    expect(dot).toContain('unknown');
  });

  it('escapes quotes and backslashes in component IDs', () => {
    const weird: TopologySnapshot = {
      components: [{ id: 'weird"id\\', kind: 'source', type: 'http', inputs: [] }],
    };
    const dot = renderDot(weird, []);
    expect(dot).toContain('"weird\\"id\\\\"');
  });
});

describe('renderMermaid', () => {
  it('produces a graph LR flowchart with one node per component and one edge per input', () => {
    const mermaid = renderMermaid(snapshot, health);
    expect(mermaid.startsWith('graph LR')).toBe(true);
    expect(mermaid).toContain('n_app_logs -->');
    expect(mermaid).toContain('n_shape');
    expect(mermaid).toContain('n_store');
  });

  it('sanitizes component IDs with characters that are not valid Mermaid identifiers', () => {
    const weird: TopologySnapshot = {
      components: [{ id: 'weird id/with-stuff', kind: 'source', type: 'http', inputs: [] }],
    };
    const mermaid = renderMermaid(weird, []);
    expect(mermaid).toContain('n_weird_id_with_stuff');
  });

  it('labels an edge that comes from a non-default port', () => {
    const mermaid = renderMermaid(snapshot, health);
    expect(mermaid).toContain('-->|errors|');
  });

  it('includes each component state in its node label', () => {
    const mermaid = renderMermaid(snapshot, health);
    expect(mermaid).toContain('failed');
    expect(mermaid).toContain('running');
  });
});
