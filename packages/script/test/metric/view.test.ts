import { MetricEvent, Timestamp, type MetricValue } from '@ferrule/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyViewToMetric,
  compile,
  metricEventSchema,
  metricEventToView,
  metricReadonlyPaths,
  outcomeForError,
  parseAndCheck,
  type Outcome,
} from '@ferrule/script';

/**
 * Compiles `source` against the metric view and runs it on `event`, mutating `event` in place on
 * `continue` (mirroring the real pipeline wrapper `packages/operators/src/script.ts` will add).
 * Throws if the program fails to compile — tests that want to assert a compile error call
 * `compileErrorsOf` instead.
 */
function runMetric(source: string, event: MetricEvent): Outcome {
  const checked = parseAndCheck(source, {
    inputSchema: metricEventSchema(),
    validateWrites: true,
    readonlyPaths: metricReadonlyPaths(),
  });
  const errors = [...checked.parseDiagnostics, ...checked.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    const text = errors.map((e) => `${e.code}: ${e.message}`).join(', ');
    throw new Error(`unexpected compile errors: ${text}`);
  }
  const program = compile(checked);
  const view = metricEventToView(event);
  const outcome = program.run(view);
  if (outcome.kind !== 'continue') return outcome;
  try {
    applyViewToMetric(event, view, checked.program.span);
  } catch (error) {
    return outcomeForError(error, checked.program.span);
  }
  return { kind: 'continue', events: [] };
}

function compileErrorCodesOf(source: string): string[] {
  const checked = parseAndCheck(source, {
    inputSchema: metricEventSchema(),
    validateWrites: true,
    readonlyPaths: metricReadonlyPaths(),
  });
  return [...checked.parseDiagnostics, ...checked.diagnostics]
    .filter((d) => d.severity === 'error')
    .map((d) => d.code);
}

function cloneSeriesLike(event: MetricEvent): unknown {
  return {
    name: event.series.name,
    namespace: event.series.namespace ?? null,
    tags: [...event.series.tags].sort(),
    kind: event.metricKind,
    value: event.value,
    timestamp: event.timestamp?.toISOString() ?? null,
    intervalMs: event.intervalMs ?? null,
  };
}

describe('metric view: compile-time validation', () => {
  it('rejects writing a non-string tag value (ferrule/ferrule#12 acceptance example)', () => {
    expect(compileErrorCodesOf('.tags.env = 1')).toContain('E301');
  });

  it('accepts writing a string tag value', () => {
    expect(compileErrorCodesOf('.tags.env = "prod"')).toEqual([]);
  });

  it('rejects changing the metric value type', () => {
    expect(compileErrorCodesOf('.value_type = "gauge"')).toContain('E311');
  });

  it('rejects assigning the wrong type to `.value`', () => {
    expect(compileErrorCodesOf('.value = "nope"')).toContain('E301');
  });

  it('accepts arithmetic on `.value`', () => {
    expect(compileErrorCodesOf('.value = .value + 1.0')).toEqual([]);
  });
});

describe('metric view: runtime write-back validation', () => {
  it('aborts with a clear reason when a required field is deleted', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
    });
    const outcome = runMetric('del(.value)', event);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.cause).toBe('abort');
    expect(outcome.reason).toContain("'.value'");
  });

  it('aborts when `.kind` is set to something other than incremental/absolute', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
    });
    const outcome = runMetric('.kind = "oops"', event);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.reason).toContain("'.kind'");
  });

  it('aborts when a tag is set to a non-string via a dynamic write', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
    });
    // `merge` keeps an `any`-rest result, so the checker can't statically catch this one (see
    // metric/schema.ts's "known soundness gap" note) — the runtime write-back check must.
    const outcome = runMetric('.tags = merge(.tags, { "env": 1 }) ?? .tags', event);
    expect(outcome.kind).toBe('abort');
    if (outcome.kind !== 'abort') return;
    expect(outcome.reason).toContain('env');
  });

  it('ignores a write to a field that does not apply to the event`s actual value type', () => {
    const event = new MetricEvent({
      name: 'x',
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
    });
    const outcome = runMetric(
      '.buckets = [{"upper_limit": 1.0, "count": 1.0}]\n.value = 9.0',
      event,
    );
    expect(outcome.kind).toBe('continue');
    expect(event.value).toEqual({ type: 'counter', value: 9 });
  });

  it('never lets a program change the metric value type, even bypassing the checker', () => {
    // Exercises the runtime half of the "changing value type is unsupported" decision directly
    // (the checker already refuses to compile this; this proves write-back ignores `.value_type`
    // unconditionally, in case some other caller compiles without `readonlyPaths`).
    const event = new MetricEvent({
      name: 'x',
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
    });
    const checked = parseAndCheck('.value_type = "gauge"', {
      inputSchema: metricEventSchema(),
      validateWrites: true,
      // no readonlyPaths: simulates a caller that skipped the metric-specific restriction
    });
    const errors = checked.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    const program = compile(checked);
    const view = metricEventToView(event);
    const outcome = program.run(view);
    expect(outcome.kind).toBe('continue');
    applyViewToMetric(event, view, checked.program.span);
    expect(event.value.type).toBe('counter');
  });
});

describe('metric view: round trip', () => {
  it('leaves every metric value bit-identical when the program touches nothing', () => {
    const event = new MetricEvent({
      name: 'http.requests',
      namespace: 'app',
      tags: { env: 'prod', region: 'eu' },
      kind: 'incremental',
      value: { type: 'counter', value: 3.5 },
      timestamp: Timestamp.fromNanos(1_700_000_000_000_000_000n),
      intervalMs: 1000,
    });
    const before = cloneSeriesLike(event);
    const outcome = runMetric('# touches nothing\nlet _unused = 1\n', event);
    expect(outcome.kind).toBe('continue');
    expect(cloneSeriesLike(event)).toEqual(before);
  });

  const arbFiniteFloat = fc.double({ noNaN: true, noDefaultInfinity: true });
  const arbTags = fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string());

  const arbValue: fc.Arbitrary<MetricValue> = fc.oneof(
    fc.record({ type: fc.constant('counter' as const), value: arbFiniteFloat }),
    fc.record({ type: fc.constant('gauge' as const), value: arbFiniteFloat }),
    fc
      .array(fc.string(), { maxLength: 5 })
      .map((values) => ({ type: 'set' as const, values: new Set(values) })),
    fc.record({
      type: fc.constant('distribution' as const),
      statistic: fc.constantFrom('histogram' as const, 'summary' as const),
      samples: fc.array(fc.record({ value: arbFiniteFloat, rate: arbFiniteFloat }), {
        maxLength: 5,
      }),
    }),
    fc.record({
      type: fc.constant('histogram' as const),
      buckets: fc.array(fc.record({ upperLimit: arbFiniteFloat, count: arbFiniteFloat }), {
        maxLength: 5,
      }),
      count: arbFiniteFloat,
      sum: arbFiniteFloat,
    }),
    fc.record({
      type: fc.constant('summary' as const),
      quantiles: fc.array(fc.record({ quantile: arbFiniteFloat, value: arbFiniteFloat }), {
        maxLength: 5,
      }),
      count: arbFiniteFloat,
      sum: arbFiniteFloat,
    }),
  );

  it('property: an untouched program round-trips every metric value type bit-identically', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
        arbTags,
        fc.constantFrom('incremental' as const, 'absolute' as const),
        arbValue,
        (name, namespace, tags, kind, value) => {
          const init: ConstructorParameters<typeof MetricEvent>[0] = { name, tags, kind, value };
          if (namespace !== undefined) init.namespace = namespace;
          const event = new MetricEvent(init);
          const before = cloneSeriesLike(event);
          const outcome = runMetric('', event);
          expect(outcome.kind).toBe('continue');
          expect(cloneSeriesLike(event)).toEqual(before);
        },
      ),
    );
  });
});
