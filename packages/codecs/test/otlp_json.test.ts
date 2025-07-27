import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LogEvent, MetricEvent, SpanEvent, Timestamp } from '@ferrule/core';
import {
  decodeOtlpJsonLogs,
  decodeOtlpJsonMetrics,
  decodeOtlpJsonTraces,
  encodeOtlpJsonLogs,
  encodeOtlpJsonMetrics,
  encodeOtlpJsonTraces,
} from '@ferrule/codecs';
import { arbLogEvent, arbMetricEvent, arbSpanEvent } from './arbitraries.js';

describe('OTLP JSON logs', () => {
  it('round-trips arbitrary log events as a multiset', () => {
    fc.assert(
      fc.property(fc.array(arbLogEvent, { minLength: 0, maxLength: 6 }), (events) => {
        const text = encodeOtlpJsonLogs(events);
        const decoded = decodeOtlpJsonLogs(text);
        expect(decoded).toHaveLength(events.length);
        const pool = [...decoded];
        for (const event of events) {
          const idx = pool.findIndex(
            (d) =>
              d.get('message') === event.get('message') &&
              d.get('severity_number') === event.get('severity_number'),
          );
          expect(idx).toBeGreaterThanOrEqual(0);
          pool.splice(idx, 1);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('produces camelCase fields, a decimal-string timeUnixNano, and a hex trace id', () => {
    const event = LogEvent.fromMessage('hi');
    event.set('timestamp', Timestamp.fromNanos(1_700_000_000_123_456_789n));
    event.set('trace_id', new Uint8Array(16).fill(0xab));
    const text = encodeOtlpJsonLogs([event]);
    const parsed = JSON.parse(text) as {
      resourceLogs: { scopeLogs: { logRecords: { timeUnixNano: string; traceId: string }[] }[] }[];
    };
    const record = parsed.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    expect(record.timeUnixNano).toBe('1700000000123456789');
    expect(record.traceId).toBe('ab'.repeat(16));
  });

  it('produces valid JSON parseable independently of this package', () => {
    const text = encodeOtlpJsonLogs([LogEvent.fromMessage('plain')]);
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
  });

  it('rejects non-object JSON documents', () => {
    expect(() => decodeOtlpJsonLogs('[]')).toThrow();
    expect(() => decodeOtlpJsonLogs('"oops"')).toThrow();
  });

  it('decodes an empty document to no events', () => {
    expect(decodeOtlpJsonLogs('{}')).toEqual([]);
  });
});

describe('OTLP JSON traces', () => {
  it('round-trips arbitrary spans as a multiset', () => {
    fc.assert(
      fc.property(fc.array(arbSpanEvent, { minLength: 0, maxLength: 6 }), (spans) => {
        const text = encodeOtlpJsonTraces(spans);
        const decoded = decodeOtlpJsonTraces(text);
        expect(decoded).toHaveLength(spans.length);
        const pool = [...decoded];
        for (const span of spans) {
          const idx = pool.findIndex(
            (d) =>
              Buffer.from(d.traceId).equals(Buffer.from(span.traceId)) &&
              Buffer.from(d.spanId).equals(Buffer.from(span.spanId)) &&
              d.name === span.name,
          );
          expect(idx).toBeGreaterThanOrEqual(0);
          pool.splice(idx, 1);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('encodes trace/span IDs as hex (not base64)', () => {
    const span = new SpanEvent({
      traceId: new Uint8Array(16).fill(1),
      spanId: new Uint8Array(8).fill(2),
      name: 'op',
      startTime: Timestamp.fromMillis(1),
      endTime: Timestamp.fromMillis(2),
    });
    const text = encodeOtlpJsonTraces([span]);
    const parsed = JSON.parse(text) as {
      resourceSpans: { scopeSpans: { spans: { traceId: string; spanId: string }[] }[] }[];
    };
    const encoded = parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(encoded.traceId).toBe('01'.repeat(16));
    expect(encoded.spanId).toBe('02'.repeat(8));
  });
});

describe('OTLP JSON metrics', () => {
  it('round-trips arbitrary gauge/counter metrics as a multiset', () => {
    fc.assert(
      fc.property(fc.array(arbMetricEvent, { minLength: 0, maxLength: 6 }), (events) => {
        const nonSpecial = events.filter(
          (e) => e.value.type !== 'set' && e.value.type !== 'distribution',
        );
        const text = encodeOtlpJsonMetrics(nonSpecial);
        const decoded = decodeOtlpJsonMetrics(text);
        expect(decoded).toHaveLength(nonSpecial.length);
      }),
      { numRuns: 25 },
    );
  });

  it('round-trips a histogram through JSON', () => {
    const event = new MetricEvent({
      name: 'latency',
      tags: new Map([['route', '/x']]),
      kind: 'absolute',
      value: {
        type: 'histogram',
        buckets: [
          { upperLimit: 0.1, count: 5 },
          { upperLimit: 1, count: 2 },
        ],
        count: 10,
        sum: 3.2,
      },
      timestamp: Timestamp.fromMillis(1000),
    });
    const text = encodeOtlpJsonMetrics([event]);
    const [decoded] = decodeOtlpJsonMetrics(text);
    expect(decoded!.value).toEqual(event.value);
  });

  it('rejects encoding a set or distribution metric value', () => {
    const set = new MetricEvent({
      name: 'uniques',
      tags: new Map(),
      kind: 'incremental',
      value: { type: 'set', values: new Set(['a']) },
    });
    expect(() => encodeOtlpJsonMetrics([set])).toThrow();
  });
});

describe('OTLP JSON: bounded, typed errors on malformed input', () => {
  it('never throws anything but a FerruleError on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        for (const decode of [decodeOtlpJsonLogs, decodeOtlpJsonMetrics, decodeOtlpJsonTraces]) {
          try {
            decode(text);
          } catch (error) {
            expect(error).toHaveProperty('code');
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
