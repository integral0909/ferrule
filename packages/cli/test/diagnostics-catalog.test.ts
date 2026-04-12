import { describe, expect, it } from 'vitest';
import { allCliCatalogEntries, explainCliCode } from '../src/diagnostics-catalog.js';

describe('diagnostics-catalog', () => {
  it('explains every topology issue code buildTopology can produce', () => {
    const codes = [
      'E_DUPLICATE_ID',
      'E_UNKNOWN_COMPONENT_TYPE',
      'E_SCHEMA',
      'E_UNKNOWN_INPUT',
      'E_SINK_AS_INPUT',
      'E_UNKNOWN_PORT',
      'E_CYCLE',
      'E_EVENT_KIND_MISMATCH',
      'E_NO_INPUTS',
      'E_COMPONENT_BUILD_FAILED',
      'W_UNUSED_SOURCE',
    ];
    for (const code of codes) {
      const entry = explainCliCode(code);
      expect(entry, `expected an entry for ${code}`).toBeDefined();
      expect(entry!.summary.length).toBeGreaterThan(0);
      expect(entry!.explanation.length).toBeGreaterThan(0);
    }
  });

  it('explains every generic schema issue code', () => {
    const codes = [
      'invalid_type',
      'required',
      'unknown_key',
      'too_small',
      'too_big',
      'invalid_string',
      'invalid_enum',
      'invalid_union',
      'invalid_format',
      'custom',
    ];
    for (const code of codes) expect(explainCliCode(code)).toBeDefined();
  });

  it('returns undefined for an unknown code', () => {
    expect(explainCliCode('NOT_A_REAL_CODE')).toBeUndefined();
  });

  it('every catalog entry has a unique code', () => {
    const entries = allCliCatalogEntries();
    const codes = entries.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(entries.length).toBeGreaterThan(15);
  });

  it('every entry is either error or warning severity', () => {
    for (const entry of allCliCatalogEntries()) {
      expect(['error', 'warning']).toContain(entry.severity);
    }
  });
});
