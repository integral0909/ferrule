import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MetricEvent } from '@ferrule/core';
import {
  decodeStatsdToMetricEvents,
  encodeMetricEventAsStatsd,
  encodeMetricEventsAsStatsdPacket,
  parseStatsdLine,
  parseStatsdPacket,
} from '@ferrule/codecs';

describe('parseStatsdLine', () => {
  it('parses a basic counter', () => {
    const [s] = parseStatsdLine('page.views:1|c');
    expect(s).toMatchObject({ name: 'page.views', type: 'c', value: 1, sampleRate: 1 });
  });

  it('parses a counter with a sample rate', () => {
    const [s] = parseStatsdLine('page.views:1|c|@0.1');
    expect(s!.sampleRate).toBe(0.1);
  });

  it('parses a gauge, including signed deltas', () => {
    const [abs] = parseStatsdLine('temp:21|g');
    expect(abs).toMatchObject({ type: 'g', value: 21, isDelta: false });
    const [inc] = parseStatsdLine('temp:+5|g');
    expect(inc).toMatchObject({ type: 'g', value: 5, isDelta: true });
    const [dec] = parseStatsdLine('temp:-3|g');
    expect(dec).toMatchObject({ type: 'g', value: -3, isDelta: true });
  });

  it('parses a timer, histogram, and distribution', () => {
    expect(parseStatsdLine('req.duration:320|ms')[0]).toMatchObject({ type: 'ms', value: 320 });
    expect(parseStatsdLine('req.duration:320|h')[0]).toMatchObject({ type: 'h', value: 320 });
    expect(parseStatsdLine('req.duration:320|d')[0]).toMatchObject({ type: 'd', value: 320 });
  });

  it('parses a set', () => {
    const [s] = parseStatsdLine('users.unique:alice|s');
    expect(s).toMatchObject({ type: 's', setMember: 'alice' });
  });

  it('parses DogStatsD tags, including a bare (valueless) tag', () => {
    const [s] = parseStatsdLine('page.views:1|c|#env:prod,region:eu,beta');
    expect(s!.tags.get('env')).toBe('prod');
    expect(s!.tags.get('region')).toBe('eu');
    expect(s!.tags.get('beta')).toBe('');
  });

  it('parses sample rate and tags together, in either order', () => {
    const [a] = parseStatsdLine('m:1|c|@0.5|#a:1');
    expect(a).toMatchObject({ sampleRate: 0.5 });
    expect(a!.tags.get('a')).toBe('1');
  });

  it('expands DogStatsD multi-value shorthand into several samples', () => {
    const samples = parseStatsdLine('m:1:2:3|c');
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.value)).toEqual([1, 2, 3]);
  });

  it('ignores unrecognised extension segments for forward compatibility', () => {
    const [s] = parseStatsdLine('m:1|c|c:some-container-id');
    expect(s).toMatchObject({ value: 1 });
  });

  it('throws on a malformed line', () => {
    expect(() => parseStatsdLine('no-colon-or-pipe')).toThrow();
    expect(() => parseStatsdLine('m:1')).toThrow();
    expect(() => parseStatsdLine('m:1|zzz')).toThrow();
    expect(() => parseStatsdLine('m:notanumber|c')).toThrow();
    expect(() => parseStatsdLine('m:1|c|@2')).toThrow(); // sample rate must be in (0, 1]
  });

  it('never throws anything but a FerruleError on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          parseStatsdLine(s);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
    );
  });
});

describe('parseStatsdPacket', () => {
  it('parses multiple newline-separated lines, skipping blanks', () => {
    const samples = parseStatsdPacket('a:1|c\n\nb:2|g\n');
    expect(samples.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('decodeStatsdToMetricEvents', () => {
  it('divides a sampled counter by its sample rate', () => {
    const [event] = decodeStatsdToMetricEvents('reqs:1|c|@0.1');
    expect(event!.value).toEqual({ type: 'counter', value: 10 });
    expect(event!.metricKind).toBe('incremental');
  });

  it('maps an absolute gauge to kind absolute and a delta gauge to kind incremental', () => {
    const [abs] = decodeStatsdToMetricEvents('temp:21|g');
    expect(abs!.metricKind).toBe('absolute');
    const [delta] = decodeStatsdToMetricEvents('temp:+5|g');
    expect(delta!.metricKind).toBe('incremental');
  });

  it('maps a timer/histogram/distribution to a one-sample distribution, weighted by 1/sampleRate', () => {
    const [event] = decodeStatsdToMetricEvents('dur:100|ms|@0.5');
    expect(event!.value).toEqual({
      type: 'distribution',
      statistic: 'histogram',
      samples: [{ value: 100, rate: 2 }],
    });
    expect(event!.metricKind).toBe('incremental');
  });

  it('maps a set to a single-member set value', () => {
    const [event] = decodeStatsdToMetricEvents('users:alice|s');
    expect(event!.value).toEqual({ type: 'set', values: new Set(['alice']) });
  });

  it('carries tags onto the metric series', () => {
    const [event] = decodeStatsdToMetricEvents('m:1|c|#env:prod');
    expect(event!.tags.get('env')).toBe('prod');
  });

  it('decodes a whole multi-line packet', () => {
    const events = decodeStatsdToMetricEvents('a:1|c\nb:2|g\nc:x|s\n');
    expect(events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('encodeMetricEventAsStatsd', () => {
  function metric(
    value: MetricEvent['value'],
    kind: MetricEvent['metricKind'] = 'absolute',
    tags: Map<string, string> = new Map(),
  ): MetricEvent {
    return new MetricEvent({ name: 'm', tags, kind, value });
  }

  it('encodes a counter', () => {
    expect(encodeMetricEventAsStatsd(metric({ type: 'counter', value: 3 }))).toEqual(['m:3|c']);
  });

  it('encodes an absolute gauge without a sign and an incremental gauge with one', () => {
    expect(encodeMetricEventAsStatsd(metric({ type: 'gauge', value: 5 }, 'absolute'))).toEqual([
      'm:5|g',
    ]);
    expect(encodeMetricEventAsStatsd(metric({ type: 'gauge', value: 5 }, 'incremental'))).toEqual([
      'm:+5|g',
    ]);
    expect(encodeMetricEventAsStatsd(metric({ type: 'gauge', value: -5 }, 'incremental'))).toEqual([
      'm:-5|g',
    ]);
  });

  it('encodes a gauge value of exactly 0 as a delta with an explicit sign', () => {
    expect(encodeMetricEventAsStatsd(metric({ type: 'gauge', value: 0 }, 'incremental'))).toEqual([
      'm:+0|g',
    ]);
  });

  it('encodes each set member as its own line', () => {
    const lines = encodeMetricEventAsStatsd(
      metric({ type: 'set', values: new Set(['alice', 'bob']) }),
    );
    expect(lines).toEqual(['m:alice|s', 'm:bob|s']);
  });

  it('encodes a distribution as one line per sample, with @rate as the inverse weight', () => {
    const lines = encodeMetricEventAsStatsd(
      metric({
        type: 'distribution',
        statistic: 'histogram',
        samples: [
          { value: 10, rate: 1 },
          { value: 20, rate: 4 },
        ],
      }),
    );
    expect(lines).toEqual(['m:10|d', 'm:20|d|@0.25']);
  });

  it('includes tags in the output', () => {
    const lines = encodeMetricEventAsStatsd(
      metric({ type: 'counter', value: 1 }, 'absolute', new Map([['env', 'prod']])),
    );
    expect(lines).toEqual(['m:1|c|#env:prod']);
  });

  it('rejects histogram, exponentialHistogram, and summary metric values', () => {
    expect(() =>
      encodeMetricEventAsStatsd(metric({ type: 'histogram', buckets: [], count: 0, sum: 0 })),
    ).toThrow();
    expect(() =>
      encodeMetricEventAsStatsd(
        metric({
          type: 'exponentialHistogram',
          scale: 0,
          zeroCount: 0,
          zeroThreshold: 0,
          positive: { offset: 0, counts: [] },
          negative: { offset: 0, counts: [] },
          count: 0,
          sum: 0,
        }),
      ),
    ).toThrow();
    expect(() =>
      encodeMetricEventAsStatsd(metric({ type: 'summary', quantiles: [], count: 0, sum: 0 })),
    ).toThrow();
  });

  it('round-trips a counter and a gauge through encode -> decode', () => {
    const events = [
      metric({ type: 'counter', value: 7 }, 'incremental'),
      metric({ type: 'gauge', value: 42 }, 'absolute'),
    ];
    const packet = encodeMetricEventsAsStatsdPacket(events);
    const decoded = decodeStatsdToMetricEvents(packet);
    expect(decoded[0]!.value).toEqual({ type: 'counter', value: 7 });
    expect(decoded[1]!.value).toEqual({ type: 'gauge', value: 42 });
  });

  it('produces empty output for an empty event list', () => {
    expect(encodeMetricEventsAsStatsdPacket([])).toBe('');
  });
});
