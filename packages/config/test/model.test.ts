import { formatIssuePath, invalid, ParseContext, type Issue } from '@ferrule/schema';
import { describe, expect, it } from 'vitest';
import {
  bufferSchema,
  globalSettingsSchema,
  parseInputRef,
  validateComponentEntry,
} from '@ferrule/config';
import { testRegistry } from './fixtures.js';

function issueStrings(issues: readonly Issue[]): string[] {
  return issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`);
}

describe('globalSettingsSchema', () => {
  it('fills in defaults for an empty config', () => {
    const result = globalSettingsSchema.parse({});
    expect(result).toEqual({
      acknowledgements: false,
      log: { level: 'info', format: 'text' },
      api: { enabled: false },
      healthchecks: { enabled: true, timeout: 5000 },
    });
  });

  it('validates nested fields, reporting every issue', () => {
    const result = globalSettingsSchema.safeParse({
      log: { level: 'verbose' },
      api: { enabled: 'yes' },
      healthchecks: { timeout: -1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(issueStrings(result.issues)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('log.level'),
        expect.stringContaining('api.enabled'),
        expect.stringContaining('healthchecks.timeout'),
      ]),
    );
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('bufferSchema', () => {
  it('validates a memory buffer', () => {
    expect(bufferSchema.parse({ type: 'memory', max_events: 100 })).toEqual({
      type: 'memory',
      max_events: 100,
    });
  });

  it('validates a disk buffer with defaults', () => {
    expect(bufferSchema.parse({ type: 'disk', max_size: '1GiB' })).toEqual({
      type: 'disk',
      max_size: 1024 * 1024 * 1024,
      when_full: 'block',
    });
  });

  it('rejects an unknown buffer type with a suggestion', () => {
    const result = bufferSchema.safeParse({ type: 'disc' });
    expect(result.ok).toBe(false);
  });
});

describe('parseInputRef', () => {
  it('parses a bare id and an id.port form', () => {
    expect(parseInputRef('app_logs')).toEqual({ id: 'app_logs' });
    expect(parseInputRef('shape.errors')).toEqual({ id: 'shape', port: 'errors' });
  });

  it('rejects malformed references', () => {
    expect(parseInputRef('')).toBeUndefined();
    expect(parseInputRef('Bad-ID')).toBeUndefined();
    expect(parseInputRef('a.b.c')).toBeUndefined();
  });
});

describe('validateComponentEntry', () => {
  const registry = testRegistry();

  function validate(raw: unknown, kind: 'source' | 'transform' | 'sink') {
    const ctx = new ParseContext();
    const result = validateComponentEntry(raw, kind, registry, ctx);
    return { result, issues: ctx.issues };
  }

  it('validates a well-formed source', () => {
    const { result, issues } = validate({ type: 'http', address: '0.0.0.0:8080' }, 'source');
    expect(issues).toEqual([]);
    expect(result).not.toBe(invalid);
    if (typeof result === 'symbol') throw new Error('unreachable');
    expect(result.type).toBe('http');
    expect(result.options).toEqual({
      address: { host: '0.0.0.0', port: 8080 },
      max_body: 1024 * 1024,
    });
  });

  it('reports a missing type', () => {
    const { issues } = validate({}, 'source');
    expect(issueStrings(issues)).toEqual(['type: is required']);
  });

  it('reports an unknown type with a "did you mean" suggestion', () => {
    const { issues } = validate({ type: 'htpp', address: '0.0.0.0:8080' }, 'source');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('htpp');
    expect(issues[0]!.message).toContain('http');
  });

  it('rejects inputs on a source', () => {
    const { issues } = validate({ type: 'http', address: '0.0.0.0:8080', inputs: ['x'] }, 'source');
    expect(issueStrings(issues)).toEqual(['inputs: sources do not accept inputs']);
  });

  it('requires inputs on a transform, accepting a single string or a list', () => {
    const missing = validate({ type: 'route', condition: 'true' }, 'transform');
    expect(issueStrings(missing.issues)).toEqual(['inputs: is required']);

    const single = validate({ type: 'route', condition: 'true', inputs: 'app_logs' }, 'transform');
    expect(single.issues).toEqual([]);
    if (typeof single.result === 'symbol') throw new Error('unreachable');
    expect(single.result.inputs).toEqual([{ id: 'app_logs' }]);
  });

  it('rejects a malformed input reference with a precise path', () => {
    const { issues } = validate(
      { type: 'route', condition: 'true', inputs: ['ok', 'Not Valid'] },
      'transform',
    );
    expect(issueStrings(issues)).toEqual([
      'inputs[1]: invalid input reference "Not Valid"; expected "id" or "id.port"',
    ]);
  });

  it('rejects a buffer on a non-sink component', () => {
    const { issues } = validate(
      { type: 'route', condition: 'true', inputs: ['a'], buffer: { type: 'memory' } },
      'transform',
    );
    expect(issueStrings(issues)).toEqual(['buffer: transforms do not accept a buffer']);
  });

  it('validates a sink buffer and acknowledgements', () => {
    const { result, issues } = validate(
      {
        type: 'console',
        inputs: ['a'],
        buffer: { type: 'disk', max_size: '2GiB', when_full: 'drop_newest' },
        acknowledgements: true,
      },
      'sink',
    );
    expect(issues).toEqual([]);
    if (typeof result === 'symbol') throw new Error('unreachable');
    expect(result.buffer).toEqual({
      type: 'disk',
      max_size: 2 * 1024 * 1024 * 1024,
      when_full: 'drop_newest',
    });
    expect(result.acknowledgements).toBe(true);
  });

  it('collects every issue in one pass: bad inputs and bad options together', () => {
    const { issues } = validate(
      { type: 'clickhouse', inputs: [123], endpoint: 'not a url', table: 5 },
      'sink',
    );
    const paths = issues.map((i) => formatIssuePath(i.path));
    expect(paths).toEqual(expect.arrayContaining(['inputs[0]', 'endpoint', 'table']));
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('stops validating options once the type itself does not resolve', () => {
    const { issues } = validate({ type: 'unknownsink', inputs: [123] }, 'sink');
    const paths = issues.map((i) => formatIssuePath(i.path));
    expect(paths).toEqual(['type', 'inputs[0]']);
  });

  it('reports nested option issues at the correct path', () => {
    const { issues } = validate(
      {
        type: 'clickhouse',
        inputs: ['a'],
        endpoint: 'https://x',
        table: 't',
        batch: { max_events: 0 },
      },
      'sink',
    );
    expect(issueStrings(issues)).toEqual(['batch.max_events: must be at least 1, got 0']);
  });
});
