import { describe, expect, it } from 'vitest';
import { LogEvent, MetricEvent, SpanEvent } from '@ferrule/core';
import {
  counter,
  distribution,
  gauge,
  histogram,
  log,
  metricSet,
  span,
  summary,
} from '@ferrule/testkit';

describe('event builders', () => {
  it('log() builds a LogEvent from plain fields', () => {
    const event = log({ status: 200, message: 'ok' });
    expect(event).toBeInstanceOf(LogEvent);
    expect(event.get('status')).toBe(200n);
    expect(event.get('message')).toBe('ok');
  });

  it('log() defaults to no fields', () => {
    expect(log().fields.size).toBe(0);
  });

  it('counter() builds an incremental counter MetricEvent', () => {
    const event = counter('requests', 3, { tags: { host: 'a' } });
    expect(event).toBeInstanceOf(MetricEvent);
    expect(event.metricKind).toBe('incremental');
    expect(event.value).toEqual({ type: 'counter', value: 3 });
    expect(event.tags.get('host')).toBe('a');
  });

  it('gauge() builds an absolute gauge MetricEvent', () => {
    const event = gauge('cpu', 0.5);
    expect(event.metricKind).toBe('absolute');
    expect(event.value).toEqual({ type: 'gauge', value: 0.5 });
  });

  it('metricSet() builds a set MetricEvent', () => {
    const event = metricSet('unique_users', ['a', 'b', 'a']);
    expect(event.value).toEqual({ type: 'set', values: new Set(['a', 'b']) });
  });

  it('histogram() builds a histogram MetricEvent', () => {
    const event = histogram('latency', [{ upperLimit: 100, count: 2 }], 2, 150);
    expect(event.value).toEqual({
      type: 'histogram',
      buckets: [{ upperLimit: 100, count: 2 }],
      count: 2,
      sum: 150,
    });
  });

  it('distribution() and summary() build their respective MetricValue shapes', () => {
    const d = distribution('d', [{ value: 1, rate: 1 }]);
    expect(d.value).toEqual({
      type: 'distribution',
      samples: [{ value: 1, rate: 1 }],
      statistic: 'histogram',
    });
    const s = summary('s', [{ quantile: 0.5, value: 10 }], 1, 10);
    expect(s.value).toEqual({
      type: 'summary',
      quantiles: [{ quantile: 0.5, value: 10 }],
      count: 1,
      sum: 10,
    });
  });

  it('span() builds a SpanEvent with deterministic default IDs', () => {
    const event = span('op');
    expect(event).toBeInstanceOf(SpanEvent);
    expect(event.name).toBe('op');
    expect(event.traceId.byteLength).toBe(16);
    expect(event.spanId.byteLength).toBe(8);
  });

  it('span() distinct calls get distinct default span IDs', () => {
    const a = span('op');
    const b = span('op');
    expect(Buffer.from(a.spanId).toString('hex')).not.toBe(Buffer.from(b.spanId).toString('hex'));
  });

  it('span() accepts explicit hex IDs and attributes', () => {
    const traceId = '00'.repeat(15) + '01';
    expect(traceId).toHaveLength(32);
    const event = span('op', {
      traceId,
      status: { code: 'error', message: 'boom' },
      attributes: { retries: 2 },
    });
    expect(event.traceIdHex).toBe(traceId);
    expect(event.status).toEqual({ code: 'error', message: 'boom' });
    expect(event.attributes.get('retries')).toBe(2n);
  });
});
