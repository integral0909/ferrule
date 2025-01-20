import { describe, expect, it } from 'vitest';
import {
  BatchNotifier,
  createMetadata,
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  LogEvent,
  MetricEvent,
  objectOf,
  SpanEvent,
  Timestamp,
  ValueTypeError,
  type Event,
} from '@ferrule/core';

const id = (n: number, len: number) => new Uint8Array(len).fill(n);

describe('LogEvent', () => {
  it('reads and writes fields by path string or parsed path', () => {
    const event = LogEvent.from({ message: 'hello', http: { status: 200 } }, { sourceId: 'in' });
    expect(event.get('.http.status')).toBe(200n);
    expect(event.get(['message'])).toBe('hello');
    event.set('.http.method', 'GET');
    expect(event.has('http.method')).toBe(true);
    expect(event.remove('.message')).toBe('hello');
    expect(event.fields).toEqual(objectOf({ http: { status: 200, method: 'GET' } }));
    expect(event.metadata.sourceId).toBe('in');
  });

  it('replaces the root only with an object', () => {
    const event = LogEvent.fromMessage('x');
    event.set('.', objectOf({ a: 1 }));
    expect(event.fields).toEqual(objectOf({ a: 1 }));
    expect(() => event.set('.', 'nope')).toThrow(ValueTypeError);
  });

  it('clones fields and finalizers independently', async () => {
    const batch = new BatchNotifier();
    const event = LogEvent.from({ a: { b: 1 } });
    event.metadata.finalizers.add(batch.createFinalizer());
    batch.seal();

    const copy = event.clone();
    copy.set('.a.b', 2n);
    expect(event.get('.a.b')).toBe(1n);

    event.metadata.finalizers.finish();
    expect(batch.isComplete).toBe(false);
    copy.metadata.finalizers.finish();
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('estimates size from its fields', () => {
    expect(LogEvent.fromMessage('x'.repeat(1000)).estimatedSize()).toBeGreaterThan(1000);
  });
});

describe('MetricEvent', () => {
  it('builds series from a tag record or map', () => {
    const m = new MetricEvent({
      name: 'requests',
      namespace: 'app',
      tags: { route: '/' },
      kind: 'incremental',
      value: { type: 'counter', value: 1 },
    });
    expect(m.name).toBe('requests');
    expect(m.series.namespace).toBe('app');
    expect(m.tags.get('route')).toBe('/');
    expect(m.timestamp).toBeUndefined();
  });

  it('clones deeply', () => {
    const m = new MetricEvent({
      name: 'latency',
      tags: new Map([['a', 'b']]),
      kind: 'absolute',
      value: { type: 'histogram', buckets: [{ upperLimit: 1, count: 1 }], count: 1, sum: 0.5 },
      timestamp: Timestamp.fromMillis(5),
      intervalMs: 10_000,
    });
    const copy = m.clone();
    copy.tags.set('a', 'changed');
    if (copy.value.type === 'histogram') copy.value.buckets[0]!.count = 99;
    expect(m.tags.get('a')).toBe('b');
    expect(m.value).toEqual({
      type: 'histogram',
      buckets: [{ upperLimit: 1, count: 1 }],
      count: 1,
      sum: 0.5,
    });
    expect(copy.timestamp).toBe(m.timestamp);
    expect(copy.intervalMs).toBe(10_000);
  });

  it('estimates size for every value type', () => {
    const base = { name: 'm', kind: 'incremental' as const };
    const sizes = [
      new MetricEvent({ ...base, value: { type: 'counter', value: 1 } }),
      new MetricEvent({ ...base, value: { type: 'set', values: new Set(['a', 'bb']) } }),
      new MetricEvent({
        ...base,
        value: { type: 'distribution', statistic: 'histogram', samples: [{ value: 1, rate: 1 }] },
      }),
      new MetricEvent({
        ...base,
        value: { type: 'summary', quantiles: [{ quantile: 0.5, value: 1 }], count: 1, sum: 1 },
      }),
    ].map((m) => m.estimatedSize());
    for (const size of sizes) expect(size).toBeGreaterThan(0);
  });
});

describe('SpanEvent', () => {
  const base = {
    traceId: id(1, 16),
    spanId: id(2, 8),
    name: 'GET /',
    startTime: Timestamp.fromMillis(1000),
    endTime: Timestamp.fromMillis(1250),
  };

  it('validates ID lengths', () => {
    expect(() => new SpanEvent({ ...base, traceId: id(1, 8) })).toThrow(ValueTypeError);
    expect(() => new SpanEvent({ ...base, spanId: id(1, 16) })).toThrow(ValueTypeError);
    expect(() => new SpanEvent({ ...base, parentSpanId: id(1, 4) })).toThrow(ValueTypeError);
  });

  it('exposes derived properties', () => {
    const span = new SpanEvent(base);
    expect(span.traceIdHex).toBe('01'.repeat(16));
    expect(span.spanIdHex).toBe('02'.repeat(8));
    expect(span.isRoot).toBe(true);
    expect(span.durationNanos).toBe(250_000_000n);
    expect(span.spanKind).toBe('unspecified');
    expect(span.status).toEqual({ code: 'unset' });
    const skewed = new SpanEvent({ ...base, endTime: Timestamp.fromMillis(0) });
    expect(skewed.durationNanos).toBe(0n);
  });

  it('clones every nested structure', () => {
    const span = new SpanEvent({
      ...base,
      parentSpanId: id(3, 8),
      traceState: 'k=v',
      attributes: objectOf({ 'http.method': 'GET' }),
      annotations: [
        { name: 'retry', time: Timestamp.fromMillis(1100), attributes: objectOf({ n: 1 }) },
      ],
      links: [{ traceId: id(4, 16), spanId: id(5, 8), attributes: new Map() }],
      scope: { name: 'lib', version: '1.0', attributes: new Map() },
      metadata: createMetadata({ sourceId: 'otlp' }),
    });
    const copy = span.clone();
    copy.attributes.set('http.method', 'POST');
    copy.annotations[0]!.attributes.set('n', 2n);
    copy.links[0]!.spanId[0] = 0;
    copy.parentSpanId![0] = 0;
    expect(span.attributes.get('http.method')).toBe('GET');
    expect(span.annotations[0]!.attributes.get('n')).toBe(1n);
    expect(span.links[0]!.spanId[0]).toBe(5);
    expect(span.parentSpanId![0]).toBe(3);
    expect(copy.traceState).toBe('k=v');
    expect(copy.scope).toEqual(span.scope);
    expect(copy.metadata.sourceId).toBe('otlp');
    expect(copy.estimatedSize()).toBeGreaterThan(0);
  });
});

describe('event guards', () => {
  it('narrow the event union', () => {
    const events: Event[] = [
      LogEvent.fromMessage('x'),
      new MetricEvent({ name: 'm', kind: 'absolute', value: { type: 'gauge', value: 1 } }),
      new SpanEvent({
        traceId: id(1, 16),
        spanId: id(1, 8),
        name: 's',
        startTime: Timestamp.fromMillis(0),
        endTime: Timestamp.fromMillis(0),
      }),
    ];
    expect(events.map(isLogEvent)).toEqual([true, false, false]);
    expect(events.map(isMetricEvent)).toEqual([false, true, false]);
    expect(events.map(isSpanEvent)).toEqual([false, false, true]);
  });
});
