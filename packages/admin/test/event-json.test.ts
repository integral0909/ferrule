import {
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  createMetadata,
  encodeJson,
  parseJson,
  type Event,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { describe, expect, it } from 'vitest';
import { eventToValue } from '../src/event-json.js';

function decode(event: Event): Value {
  return parseJson(encodeJson(eventToValue(event)));
}

function asMap(value: Value): ValueMap {
  if (!(value instanceof Map)) throw new Error('expected an object');
  return value;
}

describe('eventToValue: LogEvent', () => {
  it('carries fields and the event kind through, round-trippable via encodeJson/parseJson', () => {
    const event = LogEvent.from({ message: 'hello', count: 3 });
    const decoded = asMap(decode(event));
    expect(decoded.get('kind')).toBe('log');
    const fields = asMap(decoded.get('fields')!);
    expect(fields.get('message')).toBe('hello');
    expect(fields.get('count')).toBe(3n); // an integer round-trips as a bigint, not a float
  });

  it('includes metadata: receivedAt always, sourceId/sourceType when set', () => {
    const withSource = new LogEvent(
      new Map([['message', 'x']]),
      createMetadata({ sourceId: 'app_logs', sourceType: 'http' }),
    );
    const decoded = asMap(decode(withSource));
    const metadata = asMap(decoded.get('metadata')!);
    expect(metadata.get('sourceId')).toBe('app_logs');
    expect(metadata.get('sourceType')).toBe('http');
    expect(typeof metadata.get('receivedAt')).toBe('string'); // an ISO 8601 timestamp string

    const withoutSource = LogEvent.fromMessage('y');
    const decodedNoSource = asMap(decode(withoutSource));
    const metadataNoSource = asMap(decodedNoSource.get('metadata')!);
    expect(metadataNoSource.has('sourceId')).toBe(false);
    expect(metadataNoSource.has('sourceType')).toBe(false);
  });
});

describe('eventToValue: MetricEvent', () => {
  it('renders a counter with name, tags, kind, and value', () => {
    const event = new MetricEvent({
      name: 'requests_total',
      tags: { route: '/health' },
      kind: 'absolute',
      value: { type: 'counter', value: 42 },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });
    const decoded = asMap(decode(event));
    expect(decoded.get('name')).toBe('requests_total');
    expect(decoded.get('metricKind')).toBe('absolute');
    const tags = asMap(decoded.get('tags')!);
    expect(tags.get('route')).toBe('/health');
    const value = asMap(decoded.get('value')!);
    expect(value.get('type')).toBe('counter');
    expect(value.get('value')).toBe(42);
    expect(typeof decoded.get('timestamp')).toBe('string');
  });

  it('renders a histogram with its buckets, count, and sum', () => {
    const event = new MetricEvent({
      name: 'latency',
      kind: 'absolute',
      value: {
        type: 'histogram',
        buckets: [
          { upperLimit: 0.1, count: 2 },
          { upperLimit: 1, count: 3 },
        ],
        count: 5,
        sum: 2.5,
      },
    });
    const decoded = asMap(decode(event));
    const value = asMap(decoded.get('value')!);
    expect(value.get('type')).toBe('histogram');
    expect(value.get('count')).toBe(5);
    expect(value.get('sum')).toBe(2.5);
    const buckets = value.get('buckets') as Value[];
    expect(buckets).toHaveLength(2);
    expect(asMap(buckets[0]!).get('upperLimit')).toBe(0.1);
    expect(asMap(buckets[0]!).get('count')).toBe(2);
  });

  it('renders an exponentialHistogram with its scale, zero bucket, and sparse buckets', () => {
    const event = new MetricEvent({
      name: 'latency',
      kind: 'absolute',
      value: {
        type: 'exponentialHistogram',
        scale: 2,
        zeroCount: 1,
        zeroThreshold: 0.25,
        positive: { offset: 0, counts: [2, 3] },
        negative: { offset: -1, counts: [1] },
        count: 7,
        sum: 4.5,
      },
    });
    const decoded = asMap(decode(event));
    const value = asMap(decoded.get('value')!);
    expect(value.get('type')).toBe('exponentialHistogram');
    expect(value.get('scale')).toBe(2n);
    expect(value.get('zeroCount')).toBe(1);
    expect(value.get('zeroThreshold')).toBe(0.25);
    expect(value.get('count')).toBe(7);
    expect(value.get('sum')).toBe(4.5);
    const positive = asMap(value.get('positive')!);
    expect(positive.get('offset')).toBe(0n);
    expect(positive.get('counts')).toEqual([2, 3]);
    const negative = asMap(value.get('negative')!);
    expect(negative.get('offset')).toBe(-1n);
    expect(negative.get('counts')).toEqual([1]);
  });

  it('renders a set metric as its member values', () => {
    const event = new MetricEvent({
      name: 'unique_visitors',
      kind: 'absolute',
      value: { type: 'set', values: new Set(['a', 'b']) },
    });
    const decoded = asMap(decode(event));
    const value = asMap(decoded.get('value')!);
    expect(value.get('type')).toBe('set');
    expect(value.get('values')).toEqual(['a', 'b']);
  });

  it('omits namespace and intervalMs when not set, includes them when set', () => {
    const withExtras = new MetricEvent({
      name: 'x',
      namespace: 'ferrule',
      kind: 'absolute',
      value: { type: 'gauge', value: 1 },
      intervalMs: 5000,
    });
    const decoded = asMap(decode(withExtras));
    expect(decoded.get('namespace')).toBe('ferrule');
    expect(decoded.get('intervalMs')).toBe(5000);

    const bare = new MetricEvent({
      name: 'x',
      kind: 'absolute',
      value: { type: 'gauge', value: 1 },
    });
    const decodedBare = asMap(decode(bare));
    expect(decodedBare.has('namespace')).toBe(false);
    expect(decodedBare.has('intervalMs')).toBe(false);
    expect(decodedBare.has('timestamp')).toBe(false);
  });
});

describe('eventToValue: SpanEvent', () => {
  function span(): SpanEvent {
    return new SpanEvent({
      traceId: new Uint8Array(16).fill(1),
      spanId: new Uint8Array(8).fill(2),
      name: 'GET /health',
      spanKind: 'server',
      startTime: Timestamp.fromMillis(1000),
      endTime: Timestamp.fromMillis(1050),
      status: { code: 'ok' },
      attributes: new Map<string, Value>([['http.method', 'GET']]),
    });
  }

  it('renders trace/span IDs as hex, and passes attributes through as an object', () => {
    const decoded = asMap(decode(span()));
    expect(decoded.get('traceId')).toBe('01'.repeat(16));
    expect(decoded.get('spanId')).toBe('02'.repeat(8));
    expect(decoded.get('name')).toBe('GET /health');
    expect(decoded.get('spanKind')).toBe('server');
    const attributes = asMap(decoded.get('attributes')!);
    expect(attributes.get('http.method')).toBe('GET');
    const status = asMap(decoded.get('status')!);
    expect(status.get('code')).toBe('ok');
  });

  it('includes parentSpanId only for a non-root span', () => {
    const root = span();
    expect(asMap(decode(root)).has('parentSpanId')).toBe(false);

    const child = new SpanEvent({
      traceId: new Uint8Array(16).fill(1),
      spanId: new Uint8Array(8).fill(3),
      parentSpanId: new Uint8Array(8).fill(2),
      name: 'child',
      startTime: Timestamp.fromMillis(0),
      endTime: Timestamp.fromMillis(1),
    });
    expect(asMap(decode(child)).get('parentSpanId')).toBe('02'.repeat(8));
  });

  it('renders annotations and links as arrays of objects with hex IDs', () => {
    const event = new SpanEvent({
      traceId: new Uint8Array(16).fill(9),
      spanId: new Uint8Array(8).fill(9),
      name: 'x',
      startTime: Timestamp.fromMillis(0),
      endTime: Timestamp.fromMillis(1),
      annotations: [{ name: 'event', time: Timestamp.fromMillis(5), attributes: new Map() }],
      links: [
        {
          traceId: new Uint8Array(16).fill(4),
          spanId: new Uint8Array(8).fill(5),
          attributes: new Map(),
        },
      ],
    });
    const decoded = asMap(decode(event));
    const annotations = decoded.get('annotations') as Value[];
    expect(asMap(annotations[0]!).get('name')).toBe('event');
    const links = decoded.get('links') as Value[];
    expect(asMap(links[0]!).get('traceId')).toBe('04'.repeat(16));
    expect(asMap(links[0]!).get('spanId')).toBe('05'.repeat(8));
  });
});
