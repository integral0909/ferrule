import { MetricEvent, Timestamp, type MetricValue } from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { compile, parseAndCheck, runInlineTests, type CompiledProgram } from '@ferrule/script';

/** Compiles `source` as a metric program, asserting it has no error diagnostics. */
function compileMetric(source: string): CompiledProgram<MetricEvent> {
  const result = parseAndCheck(source, { target: 'metric' });
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    throw new Error(
      `unexpected diagnostics: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
    );
  }
  return compile(result, { target: 'metric' });
}

/** The error codes checking `source` as a metric program produces, in order. */
function metricErrors(source: string): string[] {
  const result = parseAndCheck(source, { target: 'metric' });
  return [...result.parseDiagnostics, ...result.diagnostics]
    .filter((d) => d.severity === 'error')
    .map((d) => d.code);
}

function counter(value = 1, tags: Record<string, string> = {}): MetricEvent {
  return new MetricEvent({
    name: 'requests',
    kind: 'absolute',
    tags,
    value: { type: 'counter', value },
  });
}

function histogram(): MetricEvent {
  return new MetricEvent({
    name: 'latency',
    kind: 'absolute',
    value: {
      type: 'histogram',
      buckets: [
        { upperLimit: 1, count: 2 },
        { upperLimit: 5, count: 1 },
      ],
      count: 5,
      sum: 9,
    },
  });
}

/** Runs `source` over `metric` and asserts it continued, returning the mutated metric. */
function runOk(source: string, metric: MetricEvent): MetricEvent {
  const outcome = compileMetric(source).run(metric);
  expect(outcome).toMatchObject({ kind: 'continue' });
  return metric;
}

/** Runs `source` over `metric` and returns the abort reason, asserting it aborted. */
function runAbort(source: string, metric: MetricEvent): string {
  const outcome = compileMetric(source).run(metric);
  if (outcome.kind !== 'abort') throw new Error(`expected an abort, got ${outcome.kind}`);
  expect(outcome.cause).toBe('abort');
  return outcome.reason;
}

describe('metric scripts: reading', () => {
  it('exposes every identity field through a path', () => {
    const metric = counter(3, { host: 'a' });
    metric.series.namespace = 'svc';
    metric.intervalMs = 10_000;
    // `.tags` reads as an object, so a single tag reads as a string and a missing one as null.
    const program = compileMetric(
      '.name = "{{ .name }}/{{ .namespace }}/{{ .kind }}/{{ .type }}/{{ .tags.host }}/{{ .interval_ms }}/{{ .tags.missing }}"',
    );
    expect(program.run(metric).kind).toBe('continue');
    expect(metric.series.name).toBe('requests/svc/absolute/counter/a/10000/null');
  });

  it('reads a value field that applies, and null for one that does not', () => {
    expect(runOk('.name = "{{ .value }}"', counter(7)).series.name).toBe('7.0');
    expect(runOk('.name = "{{ .buckets }}"', counter(7)).series.name).toBe('null');
    expect(runOk('.name = "{{ .count }}-{{ .sum }}"', histogram()).series.name).toBe('5.0-9.0');
  });

  it('narrows a nullable value field with `is`, which is how arithmetic on it is written', () => {
    expect(runOk('if .value is float { .value = .value * 2.0 }', counter(4)).value).toEqual({
      type: 'counter',
      value: 8,
    });
    // The same program leaves a metric without `.value` alone rather than aborting.
    expect(runOk('if .value is float { .value = .value * 2.0 }', histogram()).value).toMatchObject({
      type: 'histogram',
      sum: 9,
    });
  });

  it('`??` is the other way to handle a nullable value field', () => {
    expect(runOk('.value = (.value ?? 0.0) + 1.0', counter(4)).value).toEqual({
      type: 'counter',
      value: 5,
    });
  });

  it('`exists` reports which value fields this metric has, without aborting', () => {
    expect(
      runOk('.name = "{{ exists(.value) }}-{{ exists(.buckets) }}"', counter()).series.name,
    ).toBe('true-false');
    expect(
      runOk('.name = "{{ exists(.value) }}-{{ exists(.buckets) }}"', histogram()).series.name,
    ).toBe('false-true');
  });

  it('reads the whole metric through a bare `.` path', () => {
    const program = compileMetric('let t = get(., ["type"]) ?? "?"\n.name = t\n');
    const metric = counter();
    expect(program.run(metric).kind).toBe('continue');
    expect(metric.series.name).toBe('counter');
  });

  it('metadata paths work the same as for logs', () => {
    const metric = counter();
    metric.metadata.sourceType = 'statsd';
    expect(runOk('.tags.source = "{{ %source_type }}"', metric).series.tags.get('source')).toBe(
      'statsd',
    );
  });
});

describe('metric scripts: writing', () => {
  it('writes identity fields', () => {
    const metric = runOk(
      '.name = "hits"\n.namespace = "svc"\n.kind = "incremental"\n.interval_ms = 5000\n',
      counter(),
    );
    expect(metric.series.name).toBe('hits');
    expect(metric.series.namespace).toBe('svc');
    expect(metric.metricKind).toBe('incremental');
    expect(metric.intervalMs).toBe(5_000);
  });

  it('writes a timestamp', () => {
    const metric = runOk(".timestamp = t'2026-01-01T00:00:00Z'", counter());
    expect(metric.timestamp?.toISOString()).toBe('2026-01-01T00:00:00Z');
  });

  it('sets, replaces, and removes tags', () => {
    expect([...runOk('.tags.env = "prod"', counter(1, { host: 'a' })).series.tags]).toEqual([
      ['host', 'a'],
      ['env', 'prod'],
    ]);
    expect([...runOk('del(.tags.host)', counter(1, { host: 'a', env: 'p' })).series.tags]).toEqual([
      ['env', 'p'],
    ]);
    // Assigning `null` removes a tag, matching the `string | null` the schema gives `.tags`'s rest.
    expect([
      ...runOk('.tags.host = null', counter(1, { host: 'a', env: 'p' })).series.tags,
    ]).toEqual([['env', 'p']]);
    expect([...runOk('.tags = { "only": "this" }', counter(1, { host: 'a' })).series.tags]).toEqual(
      [['only', 'this']],
    );
  });

  it('a tag map read into a local cannot corrupt the metric', () => {
    // `.tags` reads as a copy, so mutating the local leaves the event's own tags alone.
    const metric = runOk('let mut t = .tags\nt.host = 1\n', counter(1, { host: 'a' }));
    expect(metric.series.tags.get('host')).toBe('a');
  });

  it('writes value fields of each metric type', () => {
    expect(runOk('.value = 9.5', counter()).value).toEqual({ type: 'counter', value: 9.5 });
    const set = new MetricEvent({
      name: 'users',
      kind: 'absolute',
      value: { type: 'set', values: new Set(['a']) },
    });
    expect(runOk('.values = ["x", "y"]', set).value).toEqual({
      type: 'set',
      values: new Set(['x', 'y']),
    });
    expect(runOk('.count = 6.0\n.sum = 12.0', histogram()).value).toMatchObject({
      count: 6,
      sum: 12,
    });
  });

  it('accepts an int where a float64 metric value belongs', () => {
    expect(runOk('.value = 3', counter()).value).toEqual({ type: 'counter', value: 3 });
  });

  it('writes through a path deeper than the field itself', () => {
    const metric = runOk('.buckets[0].count = 7.0', histogram());
    expect((metric.value as Extract<MetricValue, { type: 'histogram' }>).buckets).toEqual([
      { upperLimit: 1, count: 7 },
      { upperLimit: 5, count: 1 },
    ]);
  });

  it('validates a deep write just as strictly as a whole-field one', () => {
    expect(runAbort('.buckets[0].count = "x"', histogram())).toContain(
      "every element of `.buckets` must have a numeric 'count'",
    );
  });
});

describe('metric scripts: rejected writes', () => {
  it('aborts on a value field that does not apply to this metric', () => {
    expect(runAbort('.buckets = []', counter())).toBe(
      'cannot assign `.buckets`: this metric is a counter, which has no `.buckets`',
    );
  });

  // A wrongly typed *literal* write is a compile error (see 'type checking' below). These cover
  // the case the checker cannot settle: a value it can only type as `any`, where the runtime
  // validation is the sole line of defence.
  it('aborts on a wrongly typed field that only types as `any`', () => {
    const withInterval = counter();
    withInterval.intervalMs = 10_000;
    expect(runAbort('.name = get(., ["interval_ms"])!', withInterval)).toBe(
      'cannot assign an int to `.name`: expected a string',
    );
    expect(runAbort('.value = get(., ["name"])!', counter())).toContain('expected a float');
  });

  it('aborts on a non-string tag value arriving through an `any`', () => {
    expect(runAbort('.tags = get(., ["bogus"]) ?? { "n": 1 }', counter())).toBe(
      "every tag must be a string, but 'n' is an int",
    );
  });

  it('aborts on an invalid `.kind`', () => {
    expect(runAbort('.kind = "nope"', counter())).toContain(
      '`.kind` must be "incremental" or "absolute"',
    );
  });

  it('enforces the histogram bucket invariant', () => {
    expect(
      runAbort(
        '.buckets = [{ "upper_limit": 5.0, "count": 1.0 }, { "upper_limit": 1.0, "count": 1.0 }]',
        histogram(),
      ),
    ).toBe('`.buckets` upper_limits must be strictly increasing');
  });

  it('rejects a quantile outside [0, 1]', () => {
    const summary = new MetricEvent({
      name: 's',
      kind: 'absolute',
      value: { type: 'summary', quantiles: [{ quantile: 0.5, value: 1 }], count: 1, sum: 1 },
    });
    expect(runAbort('.quantiles = [{ "quantile": 2.0, "value": 1.0 }]', summary)).toContain(
      'must be within [0, 1]',
    );
  });

  it('refuses to remove a field that is not optional', () => {
    expect(runAbort('del(.name)', counter())).toBe('`.name` cannot be removed from a metric event');
  });

  it('removes the optional fields', () => {
    const metric = counter();
    metric.series.namespace = 'svc';
    metric.intervalMs = 10;
    metric.timestamp = Timestamp.fromMillis(5);
    runOk('del(.namespace)\ndel(.interval_ms)\ndel(.timestamp)', metric);
    expect(metric.series.namespace).toBeUndefined();
    expect(metric.intervalMs).toBeUndefined();
    expect(metric.timestamp).toBeUndefined();
  });
});

describe('metric scripts: type checking', () => {
  it('rejects a field a metric does not have, with a suggestion', () => {
    const result = parseAndCheck('.nmae = "x"', { target: 'metric' });
    const diagnostic = result.diagnostics.find((d) => d.code === 'E311');
    expect(diagnostic?.message).toBe('a metric event has no field `.nmae`');
    expect(diagnostic?.notes.join()).toContain('did you mean `.name`?');
  });

  it('rejects an unknown field when it is only read', () => {
    expect(metricErrors('.name = "{{ .whatever }}"')).toEqual(['E311']);
  });

  it('rejects assigning to or removing the read-only `.type`', () => {
    expect(metricErrors('.type = "gauge"')).toEqual(['E312']);
    expect(metricErrors('del(.type)')).toEqual(['E312']);
  });

  it('rejects replacing the event root', () => {
    expect(metricErrors('. = { "name": "x" }')).toEqual(['E313']);
  });

  it('rejects emit(), which produces a log event', () => {
    expect(metricErrors('emit({ "a": 1 })')).toEqual(['E313']);
  });

  it('types identity fields precisely enough to catch a mistake', () => {
    // `.name` is a `string`, so adding an int to it is a type error, unlike a log's `any` field.
    expect(metricErrors('.name = .name + 1')).toEqual(['E301']);
  });

  it('rejects a write whose value does not match the field, at compile time', () => {
    // Issue #12's worked example: this is a build-time error, not a runtime abort.
    const result = parseAndCheck('.tags.env = 1', { target: 'metric' });
    const diagnostic = result.diagnostics.find((d) => d.code === 'E301');
    expect(diagnostic?.message).toBe(
      'cannot assign a value of type `int` to `.tags.env`, which is `string | null`',
    );

    expect(metricErrors('.name = 1')).toEqual(['E301']);
    expect(metricErrors('.value = "x"')).toEqual(['E301']);
    expect(metricErrors('.kind = 3')).toEqual(['E301']);
    expect(metricErrors('.namespace = 5')).toEqual(['E301']);
    expect(metricErrors('.interval_ms = "x"')).toEqual(['E301']);
    expect(metricErrors('.values = [1]')).toEqual(['E301']);
    expect(metricErrors('.tags = { "n": 1 }')).toEqual(['E301']);
  });

  it('accepts the writes that are in fact well typed', () => {
    for (const source of [
      '.tags.env = "prod"',
      '.tags.env = null', // null clears a tag
      '.namespace = null',
      '.name = upcase(.name) ?? "x"',
      '.timestamp = now()',
      '.values = ["a"]',
      '.samples = [{ "value": 1.0, "rate": 1.0 }]',
      '.buckets[0].count = 7.0', // deeper than the field: typed `any`, validated at run time
    ]) {
      expect([source, metricErrors(source)]).toEqual([source, []]);
    }
  });

  it('accepts an int wherever a float64 metric field is declared', () => {
    // Every number in a `MetricValue` is a float64 and the runtime converts on the way in, so
    // `.value = 3` is the natural spelling and has no lossy case.
    for (const source of [
      '.value = 3',
      '.count = 2',
      '.buckets = [{ "upper_limit": 1, "count": 2 }]',
    ]) {
      expect([source, metricErrors(source)]).toEqual([source, []]);
    }
  });

  it('still allows drop and abort', () => {
    expect(compileMetric('if .name == "x" { drop }').run(counter()).kind).toBe('continue');
    expect(compileMetric('if .name == "requests" { drop }').run(counter()).kind).toBe('drop');
    expect(compileMetric('abort "nope"').run(counter())).toMatchObject({
      kind: 'abort',
      cause: 'abort',
      reason: 'nope',
    });
  });

  it('a log program is unaffected by any of this', () => {
    const result = parseAndCheck('.anything.nested = 1\n.type = "whatever"\nemit({ "a": 1 })');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('metric scripts: round trip', () => {
  /** One metric of every `MetricValue` type, with distinctive values to compare against. */
  function everyMetricType(): MetricEvent[] {
    const base = { kind: 'absolute' as const, tags: { host: 'a', env: 'prod' } };
    const metrics = [
      new MetricEvent({ ...base, name: 'c', value: { type: 'counter', value: 1.5 } }),
      new MetricEvent({ ...base, name: 'g', value: { type: 'gauge', value: -2.25 } }),
      new MetricEvent({ ...base, name: 's', value: { type: 'set', values: new Set(['a', 'b']) } }),
      new MetricEvent({
        ...base,
        name: 'd',
        value: {
          type: 'distribution',
          statistic: 'summary',
          samples: [
            { value: 1.5, rate: 0.5 },
            { value: 2.5, rate: 1 },
          ],
        },
      }),
      new MetricEvent({
        ...base,
        name: 'h',
        value: {
          type: 'histogram',
          buckets: [
            { upperLimit: 1, count: 2 },
            { upperLimit: 5, count: 3 },
          ],
          count: 7,
          sum: 11.5,
        },
      }),
      new MetricEvent({
        ...base,
        name: 'q',
        value: {
          type: 'summary',
          quantiles: [
            { quantile: 0.5, value: 1.25 },
            { quantile: 0.99, value: 9.75 },
          ],
          count: 4,
          sum: 12.5,
        },
      }),
    ];
    for (const metric of metrics) {
      metric.series.namespace = 'svc';
      metric.timestamp = Timestamp.fromMillis(1_700_000_000_000);
      metric.intervalMs = 10_000;
    }
    return metrics;
  }

  /**
   * Issue #12's acceptance bar: a program that touches nothing must leave every metric exactly as
   * it found it. Worth pinning down rather than assuming — the metric accessors convert between
   * the script's `Value` view and the stored `MetricValue` (a tag map is copied out, buckets are
   * rebuilt from plain objects), and a read path that quietly wrote back a converted value would
   * round-trip floats, drop a `namespace`, or reorder tags without any test noticing.
   */
  it.each([
    ['a program with no statements at all', ''],
    ['a program that only reads', 'let n = .name\nlet t = .tags\nlet everything = .\n'],
    [
      'a program whose writes are all in a branch that does not run',
      'if .name == "nope" { .name = "changed" }',
    ],
  ])('%s leaves every metric value bit-identical', (_label, source) => {
    const program = compileMetric(source);
    for (const metric of everyMetricType()) {
      const before = metric.clone();
      const outcome = program.run(metric);
      expect(outcome.kind).toBe('continue');
      if (outcome.kind !== 'continue') return;

      // Identity: the same object continues, not a copy.
      expect(outcome.events[0]).toBe(metric);
      expect(outcome.events).toHaveLength(1);
      // Value: every field of the series and the metric value is untouched.
      expect(metric.series).toEqual(before.series);
      expect([...metric.series.tags]).toEqual([...before.series.tags]); // including tag order
      expect(metric.value).toEqual(before.value);
      expect(metric.metricKind).toBe(before.metricKind);
      expect(metric.timestamp?.toISOString()).toBe(before.timestamp?.toISOString());
      expect(metric.intervalMs).toBe(before.intervalMs);
    }
  });

  it('a write and an equal write back leave the value bit-identical', () => {
    // Reading a value field out and assigning it straight back goes through the full
    // Value -> MetricValue conversion, so this is the narrowest check that the conversion is
    // lossless rather than merely consistent.
    for (const [source, metric] of [
      ['.value = .value ?? 0.0', everyMetricType()[0]!],
      ['.values = .values ?? []', everyMetricType()[2]!],
      ['.samples = .samples ?? []', everyMetricType()[3]!],
      ['.buckets = .buckets ?? []', everyMetricType()[4]!],
      ['.quantiles = .quantiles ?? []', everyMetricType()[5]!],
    ] as const) {
      const before = metric.clone();
      expect(compileMetric(source).run(metric).kind).toBe('continue');
      expect(metric.value).toEqual(before.value);
    }
  });
});

describe('metric scripts: inline tests', () => {
  it('builds the metric from `given` and partial-matches `expect`', () => {
    const program = compileMetric(
      '.value = (.value ?? 0.0) * 2.0\n' +
        'test "doubles" {\n' +
        '  given { "name": "c", "type": "counter", "value": 2.0, "tags": { "h": "a" } }\n' +
        '  expect { "value": 4.0, "name": "c", "tags": { "h": "a" } }\n' +
        '}\n',
    );
    expect(runInlineTests(program)).toMatchObject([{ name: 'doubles', passed: true, diffs: [] }]);
  });

  it('reports a diff when a field does not match', () => {
    const program = compileMetric(
      'test "wrong" {\n' +
        '  given { "name": "c", "type": "counter", "value": 2.0 }\n' +
        '  expect { "value": 9.0 }\n' +
        '}\n',
    );
    expect(runInlineTests(program)).toMatchObject([
      { name: 'wrong', passed: false, diffs: [{ path: 'value', expected: 9, actual: 2 }] },
    ]);
  });

  it('builds each metric value type from `given`', () => {
    const program = compileMetric(
      'test "histogram" {\n' +
        '  given { "name": "h", "type": "histogram", "buckets": [{ "upper_limit": 1.0, "count": 2.0 }], "sum": 3.0 }\n' +
        '  expect { "sum": 3.0, "count": 0.0 }\n' +
        '}\n' +
        'test "set" {\n' +
        '  given { "name": "s", "type": "set", "values": ["a"] }\n' +
        '  expect { "values": ["a"] }\n' +
        '}\n',
    );
    expect(runInlineTests(program).map((t) => t.passed)).toEqual([true, true]);
  });

  it('requires `given` to set name and type', () => {
    expect(metricErrors('test "t" { given { "name": "c" } expect { "value": 1.0 } }')).toEqual([
      'E314',
    ]);
    expect(
      metricErrors('test "t" { given { "type": "counter" } expect { "value": 1.0 } }'),
    ).toEqual(['E314']);
  });

  it('rejects an unknown field in a test fixture', () => {
    expect(
      metricErrors(
        'test "t" { given { "name": "c", "type": "counter", "nope": 1 } expect { "value": 1.0 } }',
      ),
    ).toEqual(['E311']);
  });

  it('a failed `given` build fails the test rather than throwing', () => {
    // The checker normally catches this (E314); `runInlineTests` is reachable with a
    // `CheckResult` whose diagnostics a caller ignored, so it must not throw.
    const result = parseAndCheck(
      'test "t" { given { "name": "c", "type": "nonsense" } expect {} }',
      {
        target: 'metric',
      },
    );
    const program = compile({ ...result, diagnostics: [] }, { target: 'metric' });
    expect(runInlineTests(program)).toMatchObject([
      { name: 't', passed: false, outcome: { kind: 'abort' } },
    ]);
  });
});

describe('program.target', () => {
  it('reports which kind a program was compiled for', () => {
    expect(compileMetric('.name = "x"').target).toBe('metric');
    expect(compile(parseAndCheck('.x = 1')).target).toBe('log');
  });
});

describe('metric scripts: exponential histograms', () => {
  function exponential(): MetricEvent {
    return new MetricEvent({
      name: 'latency',
      kind: 'incremental',
      value: {
        type: 'exponential_histogram',
        scale: -2,
        zeroCount: 1,
        zeroThreshold: 0,
        positive: { offset: 3, counts: [2, 4] },
        negative: { offset: 0, counts: [] },
        count: 7,
        sum: 120.5,
      },
    });
  }

  it('reads .scale as an int, and .count and .sum as floats', () => {
    expect(
      runOk('.name = "{{ .scale }}/{{ .count }}/{{ .sum }}/{{ .buckets }}"', exponential()).series
        .name,
    ).toBe('-2/7.0/120.5/null');
    expect(runOk('if .scale is int { .name = "int" }', exponential()).series.name).toBe('int');
  });

  it('.scale is null for every other metric type', () => {
    expect(runOk('.name = "{{ .scale }}"', histogram()).series.name).toBe('null');
    expect(runOk('.name = "{{ exists(.scale) }}"', counter()).series.name).toBe('false');
  });

  it('writes .count and .sum, leaving the bucket layout alone', () => {
    const metric = runOk('.sum = (.sum ?? 0.0) * 2.0\n.count = 8.0', exponential());
    expect(metric.value).toMatchObject({
      type: 'exponential_histogram',
      scale: -2,
      count: 8,
      sum: 241,
      positive: { offset: 3, counts: [2, 4] },
    });
  });

  it('rejects assigning to or removing the read-only .scale', () => {
    expect(metricErrors('.scale = 3')).toEqual(['E312']);
    expect(metricErrors('del(.scale)')).toEqual(['E312']);
  });

  it('lists only .scale, .count, and .sum among its value fields', () => {
    expect(
      runOk(
        '.name = "{{ exists(.scale) }}{{ exists(.count) }}{{ exists(.sum) }}{{ exists(.buckets) }}{{ exists(.value) }}"',
        exponential(),
      ).series.name,
    ).toBe('truetruetruefalsefalse');
  });

  it('builds an empty exponential histogram from a test fixture', () => {
    const program = compileMetric(
      'test "exp" {\n' +
        '  given { "name": "e", "type": "exponential_histogram", "sum": 3.0 }\n' +
        '  expect { "scale": 0, "count": 0.0, "sum": 3.0 }\n' +
        '}\n',
    );
    expect(runInlineTests(program).map((t) => t.passed)).toEqual([true]);
  });
});
