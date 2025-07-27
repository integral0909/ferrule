import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LimitExceededError, MetricEvent, Timestamp } from '@ferrule/core';
import { decodePrometheusText, encodePrometheusText, parsePrometheusText } from '@ferrule/codecs';

const SAMPLE = `
# HELP http_requests_total The total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="post",code="200"} 1027 1395066363000
http_requests_total{method="post",code="400"} 3
# TYPE latency_seconds histogram
latency_seconds_bucket{le="0.1"} 24054
latency_seconds_bucket{le="0.2"} 33444
latency_seconds_bucket{le="+Inf"} 44652
latency_seconds_sum 53423.2
latency_seconds_count 44652
# TYPE size_bytes summary
size_bytes{quantile="0.5"} 4
size_bytes{quantile="0.9"} 9
size_bytes_sum 100
size_bytes_count 20
metric_without_type 12.5
metric_with_nan NaN
metric_with_pos_inf +Inf
metric_with_neg_inf -Inf
`;

describe('parsePrometheusText', () => {
  it('parses HELP and TYPE metadata', () => {
    const doc = parsePrometheusText(SAMPLE);
    expect(doc.help.get('http_requests_total')).toBe('The total number of HTTP requests.');
    expect(doc.types.get('http_requests_total')).toBe('counter');
    expect(doc.types.get('latency_seconds')).toBe('histogram');
    expect(doc.types.get('size_bytes')).toBe('summary');
  });

  it('parses labels and values, including an inline timestamp', () => {
    const doc = parsePrometheusText(SAMPLE);
    const sample = doc.samples.find(
      (s) => s.name === 'http_requests_total' && s.labels.get('code') === '200',
    );
    expect(sample).toBeDefined();
    expect(sample!.value).toBe(1027);
    expect(sample!.timestampMs).toBe(1395066363000);
    expect(sample!.labels.get('method')).toBe('post');
  });

  it('parses NaN, +Inf, and -Inf sample values', () => {
    const doc = parsePrometheusText(SAMPLE);
    expect(doc.samples.find((s) => s.name === 'metric_with_nan')?.value).toBeNaN();
    expect(doc.samples.find((s) => s.name === 'metric_with_pos_inf')?.value).toBe(Infinity);
    expect(doc.samples.find((s) => s.name === 'metric_with_neg_inf')?.value).toBe(-Infinity);
  });

  it('unescapes \\\\, \\", and \\n in label values', () => {
    const doc = parsePrometheusText(String.raw`m{k="a\\b\"c\nd"} 1`);
    expect(doc.samples[0]!.labels.get('k')).toBe('a\\b"c\nd');
  });

  it('unescapes \\\\ and \\n (not \\") in HELP text', () => {
    const doc = parsePrometheusText(String.raw`# HELP m a\nb\\c`);
    expect(doc.help.get('m')).toBe('a\nb\\c');
  });

  it('handles a metric with no labels', () => {
    const doc = parsePrometheusText('m 1\n');
    expect(doc.samples[0]!.labels.size).toBe(0);
  });

  it('ignores blank lines and plain comments', () => {
    const doc = parsePrometheusText('\n# just a comment\n\nm 1\n');
    expect(doc.samples).toHaveLength(1);
  });

  it('throws on a malformed sample line', () => {
    expect(() => parsePrometheusText('not valid! 1\n')).toThrow();
    expect(() => parsePrometheusText('m{unterminated 1\n')).toThrow();
  });

  it('enforces maxSamples and maxLabels', () => {
    expect(() => parsePrometheusText('a 1\nb 2\n', { maxSamples: 1 })).toThrow(LimitExceededError);
    expect(() => parsePrometheusText('m{a="1",b="2"} 1\n', { maxLabels: 1 })).toThrow(
      LimitExceededError,
    );
  });
});

describe('decodePrometheusText', () => {
  it('decodes a counter and a plain gauge sample', () => {
    const events = decodePrometheusText(SAMPLE, { now: Timestamp.fromMillis(0) });
    const counter = events.find(
      (e) => e.name === 'http_requests_total' && e.tags.get('code') === '200',
    );
    expect(counter?.value).toEqual({ type: 'counter', value: 1027 });
    expect(counter?.metricKind).toBe('absolute');
    expect(counter?.timestamp?.toMillis()).toBe(1395066363000);

    const untyped = events.find((e) => e.name === 'metric_without_type');
    expect(untyped?.value).toEqual({ type: 'gauge', value: 12.5 });
  });

  it('assembles a histogram from _bucket/_sum/_count, converting cumulative to non-cumulative buckets', () => {
    const events = decodePrometheusText(SAMPLE, { now: Timestamp.fromMillis(0) });
    const hist = events.find((e) => e.name === 'latency_seconds');
    expect(hist).toBeDefined();
    expect(hist!.value).toEqual({
      type: 'histogram',
      buckets: [
        { upperLimit: 0.1, count: 24054 },
        { upperLimit: 0.2, count: 33444 - 24054 },
      ],
      count: 44652,
      sum: 53423.2,
    });
  });

  it('assembles a summary from quantile samples plus _sum/_count', () => {
    const events = decodePrometheusText(SAMPLE, { now: Timestamp.fromMillis(0) });
    const summary = events.find((e) => e.name === 'size_bytes');
    expect(summary!.value).toEqual({
      type: 'summary',
      quantiles: [
        { quantile: 0.5, value: 4 },
        { quantile: 0.9, value: 9 },
      ],
      count: 20,
      sum: 100,
    });
  });

  it('groups histogram/summary families by their non-le/quantile labels', () => {
    const text = `
# TYPE h histogram
h_bucket{route="/a",le="1"} 1
h_bucket{route="/a",le="+Inf"} 2
h_sum{route="/a"} 3
h_count{route="/a"} 2
h_bucket{route="/b",le="1"} 5
h_bucket{route="/b",le="+Inf"} 5
h_sum{route="/b"} 1
h_count{route="/b"} 5
`;
    const events = decodePrometheusText(text, { now: Timestamp.fromMillis(0) });
    expect(events).toHaveLength(2);
    const a = events.find((e) => e.tags.get('route') === '/a')!;
    const b = events.find((e) => e.tags.get('route') === '/b')!;
    expect((a.value as Extract<MetricEvent['value'], { type: 'histogram' }>).count).toBe(2);
    expect((b.value as Extract<MetricEvent['value'], { type: 'histogram' }>).count).toBe(5);
  });
});

describe('encodePrometheusText', () => {
  it('encodes a counter and a gauge with TYPE lines', () => {
    const events = [
      new MetricEvent({
        name: 'reqs',
        tags: new Map([['x', '1']]),
        kind: 'absolute',
        value: { type: 'counter', value: 5 },
      }),
      new MetricEvent({
        name: 'temp',
        tags: new Map(),
        kind: 'absolute',
        value: { type: 'gauge', value: -1.5 },
      }),
    ];
    const text = encodePrometheusText(events);
    expect(text).toContain('# TYPE reqs counter');
    expect(text).toContain('reqs{x="1"} 5');
    expect(text).toContain('# TYPE temp gauge');
    expect(text).toContain('temp -1.5');
  });

  it('converts non-cumulative core histogram buckets to cumulative le buckets plus a +Inf bucket', () => {
    const event = new MetricEvent({
      name: 'latency',
      tags: new Map(),
      kind: 'absolute',
      value: {
        type: 'histogram',
        buckets: [
          { upperLimit: 0.1, count: 5 },
          { upperLimit: 1, count: 10 },
        ],
        count: 20,
        sum: 8,
      },
    });
    const text = encodePrometheusText([event]);
    expect(text).toContain('latency_bucket{le="0.1"} 5');
    expect(text).toContain('latency_bucket{le="1"} 15');
    expect(text).toContain('latency_bucket{le="+Inf"} 20');
    expect(text).toContain('latency_sum 8');
    expect(text).toContain('latency_count 20');
  });

  it('encodes NaN and Infinity using Prometheus tokens', () => {
    const events = [
      new MetricEvent({
        name: 'a',
        tags: new Map(),
        kind: 'absolute',
        value: { type: 'gauge', value: NaN },
      }),
      new MetricEvent({
        name: 'b',
        tags: new Map(),
        kind: 'absolute',
        value: { type: 'gauge', value: Infinity },
      }),
    ];
    const text = encodePrometheusText(events);
    expect(text).toContain('a NaN');
    expect(text).toContain('b +Inf');
  });

  it('round-trips a counter through encode -> decode', () => {
    const event = new MetricEvent({
      name: 'my_metric',
      tags: new Map([['env', 'prod']]),
      kind: 'absolute',
      value: { type: 'counter', value: 42 },
    });
    const text = encodePrometheusText([event]);
    const [decoded] = decodePrometheusText(text);
    expect(decoded!.value).toEqual({ type: 'counter', value: 42 });
    expect(decoded!.tags.get('env')).toBe('prod');
  });

  it('escapes label values on encode', () => {
    const event = new MetricEvent({
      name: 'm',
      tags: new Map([['k', 'a"b\\c\nd']]),
      kind: 'absolute',
      value: { type: 'gauge', value: 1 },
    });
    const text = encodePrometheusText([event]);
    const [decoded] = decodePrometheusText(text);
    expect(decoded!.tags.get('k')).toBe('a"b\\c\nd');
  });

  it('produces empty output for an empty input', () => {
    expect(encodePrometheusText([])).toBe('');
  });
});

describe('Prometheus text: bounded, typed errors on malformed input', () => {
  it('never throws anything but a FerruleError on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        try {
          parsePrometheusText(text);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
      { numRuns: 200 },
    );
  });
});
