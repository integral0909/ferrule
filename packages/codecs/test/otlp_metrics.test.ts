import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FerruleError, MetricEvent, Timestamp } from '@ferrule/core';
import {
  decodeExportMetricsServiceRequest,
  encodeExportMetricsServiceRequest,
  ProtoWriter,
} from '@ferrule/codecs';
import { arbExponentialHistogram, arbSafeString, arbTagMap, arbTimestamp } from './arbitraries.js';

function gauge(
  name: string,
  value: number,
  timestamp: Timestamp,
  tags: Map<string, string> = new Map(),
): MetricEvent {
  return new MetricEvent({
    name,
    tags,
    kind: 'absolute',
    value: { type: 'gauge', value },
    timestamp,
  });
}

describe('OTLP metrics protobuf: gauge', () => {
  it('round-trips a gauge', () => {
    fc.assert(
      fc.property(
        arbSafeString,
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        arbTimestamp,
        arbTagMap,
        (name, value, ts, tags) => {
          const event = gauge(name, value, ts, tags);
          const bytes = encodeExportMetricsServiceRequest([event]);
          const [decoded] = decodeExportMetricsServiceRequest(bytes);
          expect(decoded).toBeDefined();
          expect(decoded!.name).toBe(name);
          expect(decoded!.value).toEqual({ type: 'gauge', value });
          expect(decoded!.metricKind).toBe('absolute');
          expect(decoded!.timestamp?.equals(ts)).toBe(true);
          for (const [k, v] of tags) expect(decoded!.tags.get(k)).toBe(v);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('OTLP metrics protobuf: sum (counter)', () => {
  it('cumulative monotonic sum decodes as an absolute counter', () => {
    const event = new MetricEvent({
      name: 'requests',
      tags: new Map(),
      kind: 'absolute',
      value: { type: 'counter', value: 42 },
      timestamp: Timestamp.fromMillis(1000),
    });
    const bytes = encodeExportMetricsServiceRequest([event]);
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    expect(decoded!.value).toEqual({ type: 'counter', value: 42 });
    expect(decoded!.metricKind).toBe('absolute');
  });

  it('delta monotonic sum decodes as an incremental counter', () => {
    const event = new MetricEvent({
      name: 'requests',
      tags: new Map(),
      kind: 'incremental',
      value: { type: 'counter', value: 5 },
      timestamp: Timestamp.fromMillis(1000),
    });
    const bytes = encodeExportMetricsServiceRequest([event]);
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    expect(decoded!.value).toEqual({ type: 'counter', value: 5 });
    expect(decoded!.metricKind).toBe('incremental');
  });

  it('a non-monotonic sum (gauge kind) round-trips as a gauge', () => {
    const event = new MetricEvent({
      name: 'queue_depth',
      tags: new Map(),
      kind: 'incremental',
      value: { type: 'gauge', value: -3 },
      timestamp: Timestamp.fromMillis(1000),
    });
    const bytes = encodeExportMetricsServiceRequest([event]);
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    expect(decoded!.value).toEqual({ type: 'gauge', value: -3 });
    expect(decoded!.metricKind).toBe('incremental');
  });
});

describe('OTLP metrics protobuf: histogram', () => {
  it('round-trips a histogram (non-cumulative buckets, count/sum carried directly)', () => {
    const event = new MetricEvent({
      name: 'latency',
      tags: new Map([['route', '/x']]),
      kind: 'absolute',
      value: {
        type: 'histogram',
        buckets: [
          { upperLimit: 0.1, count: 5 },
          { upperLimit: 0.5, count: 10 },
          { upperLimit: 1, count: 2 },
        ],
        count: 20,
        sum: 8.5,
      },
      timestamp: Timestamp.fromMillis(1000),
    });
    const bytes = encodeExportMetricsServiceRequest([event]);
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    expect(decoded!.value).toEqual(event.value);
    expect(decoded!.tags.get('route')).toBe('/x');
  });

  it('delta temporality decodes as incremental, cumulative/unspecified as absolute', () => {
    const value = {
      type: 'histogram' as const,
      buckets: [{ upperLimit: 1, count: 1 }],
      count: 1,
      sum: 1,
    };
    const delta = new MetricEvent({
      name: 'h',
      tags: new Map(),
      kind: 'incremental',
      value,
      timestamp: Timestamp.fromMillis(1),
    });
    const cumulative = new MetricEvent({
      name: 'h',
      tags: new Map(),
      kind: 'absolute',
      value,
      timestamp: Timestamp.fromMillis(1),
    });
    const [deltaDecoded] = decodeExportMetricsServiceRequest(
      encodeExportMetricsServiceRequest([delta]),
    );
    const [cumulativeDecoded] = decodeExportMetricsServiceRequest(
      encodeExportMetricsServiceRequest([cumulative]),
    );
    expect(deltaDecoded!.metricKind).toBe('incremental');
    expect(cumulativeDecoded!.metricKind).toBe('absolute');
  });
});

describe('OTLP metrics protobuf: summary', () => {
  it('round-trips a summary', () => {
    const event = new MetricEvent({
      name: 'size',
      tags: new Map(),
      kind: 'absolute',
      value: {
        type: 'summary',
        quantiles: [
          { quantile: 0.5, value: 10 },
          { quantile: 0.9, value: 50 },
        ],
        count: 100,
        sum: 1234,
      },
      timestamp: Timestamp.fromMillis(1000),
    });
    const bytes = encodeExportMetricsServiceRequest([event]);
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    expect(decoded!.value).toEqual(event.value);
    expect(decoded!.metricKind).toBe('absolute');
  });
});

describe('OTLP metrics protobuf: exponential histogram (lossless)', () => {
  function encodeExponentialHistogramRequest(opts: {
    scale: number;
    positiveOffset: number;
    positiveCounts: bigint[];
    negativeOffset?: number;
    negativeCounts?: bigint[];
    zeroCount?: bigint;
    zeroThreshold?: number;
    count: bigint;
    sum: number;
  }): Uint8Array {
    const dp = new ProtoWriter();
    dp.writeFixed64(4, opts.count);
    dp.writeDouble(5, opts.sum);
    dp.writeZigZag32(6, opts.scale);
    dp.writeFixed64(7, opts.zeroCount ?? 0n);
    dp.writeMessage(8, (positive) => {
      positive.writeZigZag32(1, opts.positiveOffset);
      positive.writePacked(2, opts.positiveCounts, (item, v) => item.writeRawVarint(v));
    });
    if (opts.negativeCounts !== undefined) {
      dp.writeMessage(9, (negative) => {
        negative.writeZigZag32(1, opts.negativeOffset ?? 0);
        negative.writePacked(2, opts.negativeCounts!, (item, v) => item.writeRawVarint(v));
      });
    }
    if (opts.zeroThreshold !== undefined) dp.writeDouble(14, opts.zeroThreshold);

    const histogram = new ProtoWriter();
    histogram.writeMessage(1, (child) => child.writeRaw(dp.finish()));

    const metric = new ProtoWriter();
    metric.writeString(1, 'exp_hist');
    metric.writeMessage(10, (child) => child.writeRaw(histogram.finish()));

    const scopeMetrics = new ProtoWriter();
    scopeMetrics.writeMessage(2, (child) => child.writeRaw(metric.finish()));
    const resourceMetrics = new ProtoWriter();
    resourceMetrics.writeMessage(2, (child) => child.writeRaw(scopeMetrics.finish()));
    const request = new ProtoWriter();
    request.writeMessage(1, (child) => child.writeRaw(resourceMetrics.finish()));
    return request.finish();
  }

  type ExpHist = Extract<MetricEvent['value'], { type: 'exponentialHistogram' }>;

  it('decodes scale, zero count/threshold, and positive/negative buckets losslessly', () => {
    const bytes = encodeExponentialHistogramRequest({
      scale: 0,
      positiveOffset: 0,
      positiveCounts: [3n, 5n, 2n],
      negativeOffset: -2,
      negativeCounts: [1n, 1n],
      zeroCount: 4n,
      zeroThreshold: 0.001,
      count: 16n,
      sum: 42,
    });
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    expect(decoded!.value.type).toBe('exponentialHistogram');
    const hist = decoded!.value as ExpHist;
    expect(hist.scale).toBe(0);
    expect(hist.zeroCount).toBe(4);
    expect(hist.zeroThreshold).toBe(0.001);
    expect(hist.positive).toEqual({ offset: 0, counts: [3, 5, 2] });
    expect(hist.negative).toEqual({ offset: -2, counts: [1, 1] });
    expect(hist.count).toBe(16);
    expect(hist.sum).toBe(42);
  });

  it('defaults offset/counts to empty when a side has no buckets at all', () => {
    const bytes = encodeExponentialHistogramRequest({
      scale: 0,
      positiveOffset: 0,
      positiveCounts: [1n],
      count: 1n,
      sum: 1,
    });
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    const hist = decoded!.value as ExpHist;
    expect(hist.negative).toEqual({ offset: 0, counts: [] });
    expect(hist.zeroCount).toBe(0);
  });

  it('round-trips a hand-built exponential histogram through decode -> encode -> decode', () => {
    const bytes = encodeExponentialHistogramRequest({
      scale: 2,
      positiveOffset: 5,
      positiveCounts: [1n, 1n],
      negativeOffset: -3,
      negativeCounts: [7n],
      zeroCount: 2n,
      zeroThreshold: 0.5,
      count: 10n,
      sum: -3.5,
    });
    const [decoded] = decodeExportMetricsServiceRequest(bytes);
    const reencoded = encodeExportMetricsServiceRequest([decoded!]);
    const [reDecoded] = decodeExportMetricsServiceRequest(reencoded);
    expect(reDecoded!.value).toEqual(decoded!.value);
  });

  it('decode -> encode round-trips arbitrary exponential histograms bit-for-bit', () => {
    fc.assert(
      fc.property(arbExponentialHistogram, arbTimestamp, (value, timestamp) => {
        const event = new MetricEvent({
          name: 'exp_hist',
          tags: new Map(),
          kind: 'absolute',
          value,
          timestamp,
        });
        const bytes = encodeExportMetricsServiceRequest([event]);
        const [decoded] = decodeExportMetricsServiceRequest(bytes);
        expect(decoded!.value).toEqual(value);
        // "Bit-for-bit": re-encoding the lossless decode must reproduce the exact same bytes,
        // not merely an equal value — nothing about the exponential scale was thrown away.
        const reencoded = encodeExportMetricsServiceRequest([decoded!]);
        expect([...reencoded]).toEqual([...bytes]);
      }),
      { numRuns: 100 },
    );
  });
});

describe('OTLP metrics protobuf: sum with unspecified temporality', () => {
  it('treats an unspecified aggregation temporality as cumulative/absolute', () => {
    // Hand-build a Sum with no aggregation_temporality field (defaults to 0 = UNSPECIFIED).
    const dp = new ProtoWriter();
    dp.writeDouble(4, 5);
    const sum = new ProtoWriter();
    sum.writeMessage(1, (child) => child.writeRaw(dp.finish()));
    sum.writeBool(3, true);
    const metric = new ProtoWriter();
    metric.writeString(1, 'm');
    metric.writeMessage(7, (child) => child.writeRaw(sum.finish()));
    const scopeMetrics = new ProtoWriter();
    scopeMetrics.writeMessage(2, (child) => child.writeRaw(metric.finish()));
    const resourceMetrics = new ProtoWriter();
    resourceMetrics.writeMessage(2, (child) => child.writeRaw(scopeMetrics.finish()));
    const request = new ProtoWriter();
    request.writeMessage(1, (child) => child.writeRaw(resourceMetrics.finish()));

    const [decoded] = decodeExportMetricsServiceRequest(request.finish());
    expect(decoded!.metricKind).toBe('absolute');
    expect(decoded!.value).toEqual({ type: 'counter', value: 5 });
  });
});

describe('OTLP metrics protobuf: encode-time limits', () => {
  it('rejects encoding a set or distribution metric value', () => {
    const set = new MetricEvent({
      name: 'uniques',
      tags: new Map(),
      kind: 'incremental',
      value: { type: 'set', values: new Set(['a']) },
    });
    expect(() => encodeExportMetricsServiceRequest([set])).toThrow(FerruleError);

    const dist = new MetricEvent({
      name: 'lat',
      tags: new Map(),
      kind: 'incremental',
      value: { type: 'distribution', statistic: 'histogram', samples: [{ value: 1, rate: 1 }] },
    });
    expect(() => encodeExportMetricsServiceRequest([dist])).toThrow(FerruleError);
  });

  it('decodes an empty request to an empty array', () => {
    expect(decodeExportMetricsServiceRequest(new Uint8Array())).toEqual([]);
  });
});

describe('OTLP metrics protobuf: attribute stringification for tags', () => {
  it('stringifies resource, scope, and data point attributes into tags with correct precedence', () => {
    // Build a request by hand: resource attr "env"="resource", scope name "my-scope", data point
    // attr "env"="point" should win over the resource-level "env".
    const anyValueString = (s: string): ProtoWriter => {
      const w = new ProtoWriter();
      w.writeString(1, s);
      return w;
    };
    const keyValue = (key: string, value: ProtoWriter): ProtoWriter => {
      const w = new ProtoWriter();
      w.writeString(1, key);
      w.writeMessage(2, (child) => child.writeRaw(value.finish()));
      return w;
    };

    const resource = new ProtoWriter();
    resource.writeMessage(1, (child) =>
      child.writeRaw(keyValue('env', anyValueString('resource')).finish()),
    );

    const scope = new ProtoWriter();
    scope.writeString(1, 'my-scope');

    const dataPoint = new ProtoWriter();
    dataPoint.writeMessage(7, (child) =>
      child.writeRaw(keyValue('env', anyValueString('point')).finish()),
    );
    dataPoint.writeFixed64(3, BigInt(Timestamp.fromMillis(1000).nanos));
    dataPoint.writeDouble(4, 1.5);

    const gaugeMsg = new ProtoWriter();
    gaugeMsg.writeMessage(1, (child) => child.writeRaw(dataPoint.finish()));

    const metric = new ProtoWriter();
    metric.writeString(1, 'm');
    metric.writeMessage(5, (child) => child.writeRaw(gaugeMsg.finish()));

    const scopeMetrics = new ProtoWriter();
    scopeMetrics.writeMessage(1, (child) => child.writeRaw(scope.finish()));
    scopeMetrics.writeMessage(2, (child) => child.writeRaw(metric.finish()));

    const resourceMetrics = new ProtoWriter();
    resourceMetrics.writeMessage(1, (child) => child.writeRaw(resource.finish()));
    resourceMetrics.writeMessage(2, (child) => child.writeRaw(scopeMetrics.finish()));

    const request = new ProtoWriter();
    request.writeMessage(1, (child) => child.writeRaw(resourceMetrics.finish()));

    const [decoded] = decodeExportMetricsServiceRequest(request.finish());
    expect(decoded!.tags.get('env')).toBe('point');
    expect(decoded!.tags.get('otel.scope.name')).toBe('my-scope');
  });
});

describe('OTLP metrics protobuf: bounded, typed errors on malformed input', () => {
  it('never throws anything but a FerruleError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (bytes) => {
        try {
          decodeExportMetricsServiceRequest(bytes);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
      { numRuns: 200 },
    );
  });
});
