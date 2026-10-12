import {
  createMetadata,
  SpanEvent,
  Timestamp,
  toHex,
  type SpanInit,
  type Value,
} from '@ferrule/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyViewToSpan,
  compile,
  outcomeForError,
  parseAndCheck,
  spanEventSchema,
  spanEventToView,
  spanReadonlyPaths,
  type Outcome,
} from '@ferrule/script';

function idBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed * 2654435761 + i * 97) % 256;
  if (out.every((b) => b === 0)) out[length - 1] = 1;
  return out;
}

function makeSpan(init: Partial<SpanInit> = {}): SpanEvent {
  const ctor: SpanInit = {
    traceId: idBytes(16, 1),
    spanId: idBytes(8, 1),
    name: 'op',
    startTime: Timestamp.fromNanos(0n),
    endTime: Timestamp.fromNanos(1_000_000n),
    metadata: createMetadata(),
    ...init,
  };
  return new SpanEvent(ctor);
}

const SPAN_CHECK_OPTIONS = {
  inputSchema: spanEventSchema(),
  validateWrites: true,
  readonlyPaths: spanReadonlyPaths(),
};

/** Compiles `source` against the span view and runs it on `event`, mutating `event` in place on
 * `continue` (mirroring `packages/operators/src/script.ts`'s span wrapper). Throws on a compile
 * error — tests that want to assert one call `compileErrorCodesOf` instead. */
function runSpan(source: string, event: SpanEvent): Outcome {
  const checked = parseAndCheck(source, SPAN_CHECK_OPTIONS);
  const errors = [...checked.parseDiagnostics, ...checked.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    const text = errors.map((e) => `${e.code}: ${e.message}`).join(', ');
    throw new Error(`unexpected compile errors: ${text}`);
  }
  const program = compile(checked);
  const view = spanEventToView(event);
  const outcome = program.run(view);
  if (outcome.kind !== 'continue') return outcome;
  try {
    applyViewToSpan(event, view, checked.program.span);
  } catch (error) {
    return outcomeForError(error, checked.program.span);
  }
  return { kind: 'continue', events: [] };
}

function compileErrorCodesOf(source: string): string[] {
  const checked = parseAndCheck(source, SPAN_CHECK_OPTIONS);
  return [...checked.parseDiagnostics, ...checked.diagnostics]
    .filter((d) => d.severity === 'error')
    .map((d) => d.code);
}

describe('span view: compile-time validation', () => {
  it.each(['trace_id', 'span_id', 'parent_span_id', 'duration', 'annotations', 'links'])(
    'rejects assigning to the read-only field .%s',
    (field) => {
      expect(compileErrorCodesOf(`.${field} = .${field}`)).toContain('E311');
    },
  );

  it('rejects a nested write under a read-only field, not just a bare reassignment', () => {
    expect(compileErrorCodesOf('.annotations[0].name = "x"')).toContain('E311');
    expect(compileErrorCodesOf('.links[0].attributes.x = 1')).toContain('E311');
  });

  it('still permits reading read-only fields, including nested', () => {
    expect(compileErrorCodesOf('let x = .trace_id')).toEqual([]);
    expect(compileErrorCodesOf('let x = .annotations[0].attributes')).toEqual([]);
  });

  it('accepts writing the writable scalar fields', () => {
    expect(compileErrorCodesOf('.name = "new-name"')).toEqual([]);
    expect(compileErrorCodesOf('.kind = "server"')).toEqual([]);
    expect(compileErrorCodesOf('.trace_state = "congestion=1"')).toEqual([]);
    expect(compileErrorCodesOf(".start_time = t'2026-01-01T00:00:00Z'")).toEqual([]);
  });

  it('accepts writing into `.status`, `.attributes`, `.resource`', () => {
    expect(compileErrorCodesOf('.status.code = "ok"')).toEqual([]);
    expect(compileErrorCodesOf('.status.message = "done"')).toEqual([]);
    expect(compileErrorCodesOf('.attributes.http_method = "GET"')).toEqual([]);
    expect(compileErrorCodesOf('.resource.service_name = "checkout"')).toEqual([]);
  });

  it('rejects assigning the wrong type to a known field', () => {
    expect(compileErrorCodesOf('.name = 1')).toContain('E301');
    expect(compileErrorCodesOf('.status = "ok"')).toContain('E301');
  });
});

describe('span view: runtime write-back validation', () => {
  it('aborts when `.kind` is set to something other than a valid SpanKind', () => {
    const span = makeSpan();
    const outcome = runSpan('.kind = "bogus"', span);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.cause).toBe('abort');
    expect(outcome.reason).toContain("'.kind'");
  });

  it('aborts when `.status.code` is set to something other than unset/ok/error', () => {
    const span = makeSpan();
    const outcome = runSpan('.status.code = "bogus"', span);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.reason).toContain("'.status.code'");
  });

  it('aborts with a clear reason when `.attributes` is deleted', () => {
    const span = makeSpan();
    const outcome = runSpan('del(.attributes)', span);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.reason).toContain("'.attributes'");
  });

  it('aborts with a clear reason when `.name` is deleted', () => {
    const span = makeSpan();
    const outcome = runSpan('del(.name)', span);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.reason).toContain("'.name'");
  });

  it('never lets a program change read-only fields, even bypassing the checker', () => {
    // Exercises the runtime half directly: compile without `readonlyPaths`, so the checker lets
    // `.duration`/`.annotations` writes through, and prove write-back still ignores them.
    const span = makeSpan({
      annotations: [{ name: 'x', time: Timestamp.now(), attributes: new Map() }],
    });
    const checked = parseAndCheck('.duration = 999\n.annotations = []', {
      inputSchema: spanEventSchema(),
      validateWrites: true,
      // no readonlyPaths
    });
    const errors = checked.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    const program = compile(checked);
    const view = spanEventToView(span);
    const outcome = program.run(view);
    expect(outcome.kind).toBe('continue');
    applyViewToSpan(span, view, checked.program.span);
    expect(span.durationNanos).toBe(1_000_000n); // unchanged, derived from start/end time
    expect(span.annotations).toHaveLength(1); // unchanged
  });
});

describe('span view: round trip', () => {
  it('leaves every field bit-identical when the program touches nothing', () => {
    const span = makeSpan({
      traceState: 'congestion=1',
      status: { code: 'error', message: 'boom' },
      attributes: new Map<string, Value>([['http.method', 'GET']]),
      resource: new Map<string, Value>([['service.name', 'checkout']]),
      annotations: [{ name: 'evt', time: Timestamp.fromNanos(500_000n), attributes: new Map() }],
      links: [{ traceId: idBytes(16, 2), spanId: idBytes(8, 2), attributes: new Map() }],
    });
    const before = span.clone();
    const outcome = runSpan('# touches nothing\nlet _unused = 1\n', span);
    expect(outcome.kind).toBe('continue');
    expect(span.name).toBe(before.name);
    expect(span.spanKind).toBe(before.spanKind);
    expect(span.traceState).toBe(before.traceState);
    expect(span.status).toEqual(before.status);
    expect([...span.attributes]).toEqual([...before.attributes]);
    expect([...span.resource]).toEqual([...before.resource]);
    expect(toHex(span.traceId)).toBe(toHex(before.traceId));
    expect(toHex(span.spanId)).toBe(toHex(before.spanId));
  });

  const arbAttrValue: fc.Arbitrary<string> = fc.string();
  const arbAttributes = fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), arbAttrValue);

  it('property: an untouched program round-trips every span field bit-identically', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.constantFrom(
          'unspecified' as const,
          'internal' as const,
          'server' as const,
          'client' as const,
          'producer' as const,
          'consumer' as const,
        ),
        fc.constantFrom('unset' as const, 'ok' as const, 'error' as const),
        arbAttributes,
        (name, kind, statusCode, attrs) => {
          const span = makeSpan({
            name,
            spanKind: kind,
            status: { code: statusCode },
            attributes: new Map<string, Value>(Object.entries(attrs)),
          });
          const before = span.clone();
          const outcome = runSpan('', span);
          expect(outcome.kind).toBe('continue');
          expect(span.name).toBe(before.name);
          expect(span.spanKind).toBe(before.spanKind);
          expect(span.status).toEqual(before.status);
          expect([...span.attributes]).toEqual([...before.attributes]);
        },
      ),
    );
  });
});
