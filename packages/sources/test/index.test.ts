import { describe, expect, it } from 'vitest';
import { builtinSources } from '../src/index.js';

describe('builtinSources', () => {
  it('returns exactly the eleven documented sources, each with a unique type and a valid schema', () => {
    const sources = builtinSources();
    const types = sources.map((s) => s.type).sort();
    expect(types).toEqual(
      [
        'demo_logs',
        'file',
        'heartbeat',
        'http_server',
        'internal_metrics',
        'kafka',
        'otlp',
        'prometheus_scrape',
        'statsd',
        'stdin',
        'syslog',
      ].sort(),
    );
    expect(new Set(types).size).toBe(types.length);
  });

  it('every source has a non-empty description and a working options schema', () => {
    for (const source of builtinSources()) {
      expect(source.kind).toBe('source');
      expect(source.description.length).toBeGreaterThan(0);
      // Every source's schema must at least produce a doc tree and accept its own examples (if any).
      expect(source.options.toDoc().type).toBe('object');
      for (const example of source.examples ?? []) {
        const result = source.options.safeParse(example.config);
        expect(
          result.ok,
          `example ${JSON.stringify(example.title)} for ${source.type} should validate`,
        ).toBe(true);
      }
    }
  });
});
