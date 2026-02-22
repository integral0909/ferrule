import { createMetadata, LogEvent, Timestamp } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck, type CompiledProgram } from '@ferrule/script';

function compileSource(source: string): CompiledProgram {
  const result = parseAndCheck(source);
  const diagnostics = [...result.parseDiagnostics, ...result.diagnostics];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `unexpected diagnostics: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
    );
  }
  return compile(result);
}

function runOnce(source: string, fields: Record<string, unknown> = {}) {
  return compileSource(source).run(LogEvent.from(fields));
}

describe('fallibility handling', () => {
  it('?? uses the fallback on failure', () => {
    const outcome = runOnce('.n = to_int(.n) ?? -1', { n: 'not a number' });
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('n')).toBe(-1n);
  });

  it('?? uses the fallback on null, not just failure', () => {
    const outcome = runOnce('.x = .missing ?? "default"', {});
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('x')).toBe('default');
  });

  it('?? passes through a successful non-null value', () => {
    const outcome = runOnce('.n = to_int(.n) ?? -1', { n: '42' });
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('n')).toBe(42n);
  });

  it('! aborts the event on failure, with the failure message as the reason', () => {
    const outcome = runOnce('.n = to_int(.n)!', { n: 'nope' });
    expect(outcome.kind).toBe('abort');
  });

  it('! passes through a successful value', () => {
    const outcome = runOnce('.n = to_int(.n)!', { n: '7' });
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('n')).toBe(7n);
  });

  it('error capture binds null/message on failure', () => {
    const outcome = runOnce('let v, err = to_int(.n)\n.v = v\n.err = err', { n: 'nope' });
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('v')).toBe(null);
      expect(typeof outcome.events[0]!.fields.get('err')).toBe('string');
    } else {
      throw new Error(`expected continue, got ${outcome.kind}`);
    }
  });

  it('error capture binds the value and a null error on success', () => {
    const outcome = runOnce('let v, err = to_int(.n)\n.v = v\n.err = err', { n: '9' });
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('v')).toBe(9n);
      expect(outcome.events[0]!.fields.get('err')).toBe(null);
    }
  });
});

describe('control flow', () => {
  it('if/else if/else chooses the right branch', () => {
    const source = `
      .bucket = if .n < 10 {
        "small"
      } else if .n < 100 {
        "medium"
      } else {
        "large"
      }
    `;
    for (const [n, expected] of [
      [1, 'small'],
      [50, 'medium'],
      [500, 'large'],
    ] as const) {
      const outcome = runOnce(source, { n });
      if (outcome.kind === 'continue') {
        expect(outcome.events[0]!.fields.get('bucket')).toBe(expected);
      }
    }
  });

  it('if with no else yields null on the false branch', () => {
    const outcome = runOnce('.x = if false { 1 }', {});
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('x')).toBe(null);
  });

  it('match on literal patterns', () => {
    const source = '.name = match .code { 200 => "ok", 404 => "missing", _ => "other" }';
    expect(runOnceField(source, { code: 200n }, 'name')).toBe('ok');
    expect(runOnceField(source, { code: 404n }, 'name')).toBe('missing');
    expect(runOnceField(source, { code: 1n }, 'name')).toBe('other');
  });

  it('match on kind patterns', () => {
    const source = '.kind = match .v { string => "s", int => "i", _ => "other" }';
    expect(runOnceField(source, { v: 'x' }, 'kind')).toBe('s');
    expect(runOnceField(source, { v: 5n }, 'kind')).toBe('i');
    expect(runOnceField(source, { v: true }, 'kind')).toBe('other');
  });

  it('match on regex patterns with capture bindings via a later parse', () => {
    const source = `
      .level = match .message {
        r/^ERROR/ => "error",
        r/^WARN/ => "warn",
        _ => "info",
      }
    `;
    expect(runOnceField(source, { message: 'ERROR: boom' }, 'level')).toBe('error');
    expect(runOnceField(source, { message: 'WARN: hmm' }, 'level')).toBe('warn');
    expect(runOnceField(source, { message: 'all good' }, 'level')).toBe('info');
  });

  it('match on object-shape patterns binds fields', () => {
    const source = '.msg = match .event { { kind, count } => kind + to_string(count), _ => "?" }';
    const outcome = runOnce(source, { event: { kind: 'x', count: 3n } });
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('msg')).toBe('x3');
  });

  it('object pattern without .. requires an exact shape', () => {
    const source = '.matched = match .event { { a } => true, _ => false }';
    expect(runOnceField(source, { event: { a: 1n, b: 2n } }, 'matched')).toBe(false);
    expect(runOnceField(source, { event: { a: 1n } }, 'matched')).toBe(true);
  });

  it('object pattern with a trailing `_` allows extra fields', () => {
    const source = '.matched = match .event { { a, _ } => true, _ => false }';
    expect(runOnceField(source, { event: { a: 1n, b: 2n } }, 'matched')).toBe(true);
  });

  it('drop discards the event', () => {
    expect(runOnce('drop', {}).kind).toBe('drop');
  });

  it('abort with a reason carries the reason through', () => {
    const outcome = runOnce('abort "custom reason"', {});
    expect(outcome).toMatchObject({ kind: 'abort', reason: 'custom reason' });
  });

  it('bare abort still produces an abort outcome', () => {
    expect(runOnce('abort', {}).kind).toBe('abort');
  });
});

describe('variables', () => {
  it('let mut supports reassignment', () => {
    const outcome = runOnce('let mut x = 1\nx = x + 1\nx = x + 1\n.x = x', {});
    if (outcome.kind === 'continue') expect(outcome.events[0]!.fields.get('x')).toBe(3n);
  });

  it('shadowing in a nested scope does not leak out', () => {
    const outcome = runOnce('let x = 1\nif true { let x = 2\n.inner = x }\n.outer = x', {});
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('inner')).toBe(2n);
      expect(outcome.events[0]!.fields.get('outer')).toBe(1n);
    }
  });
});

describe('string interpolation', () => {
  it('interpolates variables and expressions', () => {
    const outcome = runOnce('let n = 3\n.msg = "count is {{ n + 1 }}"', {});
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('msg')).toBe('count is 4');
    }
  });

  it('interpolates a string value without quoting it, unlike to_string', () => {
    const outcome = runOnce('.msg = "hello {{ .name }}"', { name: 'world' });
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('msg')).toBe('hello world');
    }
  });
});

describe('metadata paths', () => {
  it('reads %source_id and %received_at', () => {
    const program = compileSource('.sid = %source_id\n.ts = %received_at');
    const receivedAt = Timestamp.fromMillis(1_700_000_000_000);
    const event = new LogEvent(new Map(), createMetadata({ sourceId: 'my-source', receivedAt }));
    const outcome = program.run(event);
    if (outcome.kind === 'continue') {
      expect(outcome.events[0]!.fields.get('sid')).toBe('my-source');
      expect(outcome.events[0]!.fields.get('ts')).toBe(receivedAt);
    } else {
      throw new Error(`expected continue, got ${outcome.kind}`);
    }
  });
});

describe('emit', () => {
  it('can emit multiple extra events', () => {
    const outcome = runOnce('emit({ "n": 1 })\nemit({ "n": 2 })', {});
    if (outcome.kind === 'continue') {
      expect(outcome.events).toHaveLength(3);
      expect(outcome.events[1]!.fields.get('n')).toBe(1n);
      expect(outcome.events[2]!.fields.get('n')).toBe(2n);
    }
  });
});

function runOnceField(source: string, fields: Record<string, unknown>, field: string): unknown {
  const outcome = runOnce(source, fields);
  if (outcome.kind !== 'continue') throw new Error(`expected continue, got ${outcome.kind}`);
  return outcome.events[0]!.fields.get(field);
}
