import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MetricEvent, SpanEvent } from '@ferrule/core';
import {
  FerruleError,
  LogEvent,
  Timestamp,
  valuesEqual,
  type Event,
  type Value,
} from '@ferrule/core';
import {
  CodecLimitExceededError,
  CodecMalformedError,
  CodecVersionError,
  decodeEvent,
  decodeEventBatch,
  encodeEvent,
  encodeEventBatch,
  FORMAT_VERSION,
} from '@ferrule/buffer';
import { arbEvent, arbLogEvent, arbMetricEvent, arbSpanEvent } from './arbitraries.js';

/** Structural equality for events good enough for round-trip assertions in these tests. */
function eventsEqual(a: Event, b: Event): boolean {
  if (a.kind !== b.kind) return false;
  if (
    a.metadata.sourceId !== b.metadata.sourceId ||
    a.metadata.sourceType !== b.metadata.sourceType ||
    !a.metadata.receivedAt.equals(b.metadata.receivedAt)
  ) {
    return false;
  }
  if (a.kind === 'log' && b.kind === 'log') return valuesEqual(a.fields, b.fields);
  if (a.kind === 'metric' && b.kind === 'metric') return metricEventsEqual(a, b);
  if (a.kind === 'span' && b.kind === 'span') return spanEventsEqual(a, b);
  return false;
}

function metricEventsEqual(a: MetricEvent, b: MetricEvent): boolean {
  if (a.series.name !== b.series.name || a.series.namespace !== b.series.namespace) return false;
  if (a.metricKind !== b.metricKind) return false;
  if (a.series.tags.size !== b.series.tags.size) return false;
  for (const [k, v] of a.series.tags) if (b.series.tags.get(k) !== v) return false;
  if ((a.timestamp === undefined) !== (b.timestamp === undefined)) return false;
  if (a.timestamp !== undefined && b.timestamp !== undefined && !a.timestamp.equals(b.timestamp)) {
    return false;
  }
  if (!sameNumberOrBothNaN(a.intervalMs, b.intervalMs)) return false;
  return metricValuesEqual(a.value, b.value);
}

function sameNumberOrBothNaN(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return a === b;
}

function metricValuesEqual(a: MetricEvent['value'], b: MetricEvent['value']): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'counter':
    case 'gauge':
      return sameNumberOrBothNaN(a.value, (b as typeof a).value);
    case 'set': {
      const bv = (b as typeof a).values;
      if (a.values.size !== bv.size) return false;
      for (const v of a.values) if (!bv.has(v)) return false;
      return true;
    }
    case 'distribution': {
      const bd = b as typeof a;
      if (a.statistic !== bd.statistic || a.samples.length !== bd.samples.length) return false;
      return a.samples.every(
        (s, i) =>
          sameNumberOrBothNaN(s.value, bd.samples[i]!.value) &&
          sameNumberOrBothNaN(s.rate, bd.samples[i]!.rate),
      );
    }
    case 'histogram': {
      const bh = b as typeof a;
      if (a.buckets.length !== bh.buckets.length) return false;
      return (
        a.buckets.every(
          (bucket, i) =>
            sameNumberOrBothNaN(bucket.upperLimit, bh.buckets[i]!.upperLimit) &&
            sameNumberOrBothNaN(bucket.count, bh.buckets[i]!.count),
        ) &&
        sameNumberOrBothNaN(a.count, bh.count) &&
        sameNumberOrBothNaN(a.sum, bh.sum)
      );
    }
    case 'summary': {
      const bs = b as typeof a;
      if (a.quantiles.length !== bs.quantiles.length) return false;
      return (
        a.quantiles.every(
          (q, i) =>
            sameNumberOrBothNaN(q.quantile, bs.quantiles[i]!.quantile) &&
            sameNumberOrBothNaN(q.value, bs.quantiles[i]!.value),
        ) &&
        sameNumberOrBothNaN(a.count, bs.count) &&
        sameNumberOrBothNaN(a.sum, bs.sum)
      );
    }
    case 'exponentialHistogram': {
      const be = b as typeof a;
      return (
        sameExponentialBuckets(a.positive, be.positive) &&
        sameExponentialBuckets(a.negative, be.negative) &&
        sameNumberOrBothNaN(a.scale, be.scale) &&
        sameNumberOrBothNaN(a.zeroCount, be.zeroCount) &&
        sameNumberOrBothNaN(a.zeroThreshold, be.zeroThreshold) &&
        sameNumberOrBothNaN(a.count, be.count) &&
        sameNumberOrBothNaN(a.sum, be.sum)
      );
    }
  }
}

function sameExponentialBuckets(
  a: { offset: number; counts: number[] },
  b: { offset: number; counts: number[] },
): boolean {
  if (a.offset !== b.offset || a.counts.length !== b.counts.length) return false;
  return a.counts.every((c, i) => sameNumberOrBothNaN(c, b.counts[i]));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function spanEventsEqual(a: SpanEvent, b: SpanEvent): boolean {
  if (!bytesEqual(a.traceId, b.traceId) || !bytesEqual(a.spanId, b.spanId)) return false;
  if ((a.parentSpanId === undefined) !== (b.parentSpanId === undefined)) return false;
  if (a.parentSpanId && b.parentSpanId && !bytesEqual(a.parentSpanId, b.parentSpanId)) return false;
  if (a.traceState !== b.traceState) return false;
  if (a.name !== b.name || a.spanKind !== b.spanKind) return false;
  if (!a.startTime.equals(b.startTime) || !a.endTime.equals(b.endTime)) return false;
  if (a.status.code !== b.status.code || a.status.message !== b.status.message) return false;
  if (!valuesEqual(a.attributes, b.attributes) || !valuesEqual(a.resource, b.resource)) {
    return false;
  }
  if (a.annotations.length !== b.annotations.length) return false;
  for (let i = 0; i < a.annotations.length; i++) {
    const x = a.annotations[i]!;
    const y = b.annotations[i]!;
    if (x.name !== y.name || !x.time.equals(y.time) || !valuesEqual(x.attributes, y.attributes)) {
      return false;
    }
  }
  if (a.links.length !== b.links.length) return false;
  for (let i = 0; i < a.links.length; i++) {
    const x = a.links[i]!;
    const y = b.links[i]!;
    if (!bytesEqual(x.traceId, y.traceId) || !bytesEqual(x.spanId, y.spanId)) return false;
    if (x.traceState !== y.traceState || !valuesEqual(x.attributes, y.attributes)) return false;
  }
  if ((a.scope === undefined) !== (b.scope === undefined)) return false;
  if (a.scope && b.scope) {
    if (a.scope.name !== b.scope.name || a.scope.version !== b.scope.version) return false;
    if (!valuesEqual(a.scope.attributes, b.scope.attributes)) return false;
  }
  return true;
}

/** Encodes then decodes `event` and asserts the result is structurally identical to it. */
function expectRoundTrips(event: Event): void {
  const decoded = decodeEvent(encodeEvent(event));
  expect(eventsEqual(decoded, event)).toBe(true);
}

describe('encodeEvent / decodeEvent', () => {
  it('starts with the format version byte', () => {
    const bytes = encodeEvent(LogEvent.fromMessage('hi'));
    expect(bytes[0]).toBe(FORMAT_VERSION);
  });

  it('round-trips log events losslessly (property)', () => {
    fc.assert(fc.property(arbLogEvent, expectRoundTrips));
  });

  it('documents that an unpaired UTF-16 surrogate is replaced with U+FFFD, not lost or crashed on', () => {
    const event = LogEvent.from({ s: '\ud800lone' });
    const decoded = decodeEvent(encodeEvent(event)) as LogEvent;
    expect(decoded.get('s')).toBe('�lone');
  });

  it('round-trips metric events losslessly (property)', () => {
    fc.assert(fc.property(arbMetricEvent, expectRoundTrips));
  });

  it('round-trips span events losslessly (property)', () => {
    fc.assert(fc.property(arbSpanEvent, expectRoundTrips));
  });

  it('round-trips any event kind losslessly (property)', () => {
    fc.assert(fc.property(arbEvent, expectRoundTrips));
  });

  it('drops finalizers but preserves sourceId/sourceType/receivedAt', () => {
    const event = LogEvent.from(
      { a: 1 },
      {
        sourceId: 'src-1',
        sourceType: 'http',
        receivedAt: Timestamp.fromMillis(1_700_000_000_000),
      },
    );
    const decoded = decodeEvent(encodeEvent(event)) as LogEvent;
    expect(decoded.metadata.sourceId).toBe('src-1');
    expect(decoded.metadata.sourceType).toBe('http');
    expect(decoded.metadata.receivedAt.equals(event.metadata.receivedAt)).toBe(true);
    expect(decoded.metadata.finalizers.isEmpty).toBe(true);
  });

  it('preserves undefined sourceId/sourceType', () => {
    const event = LogEvent.fromMessage('x');
    const decoded = decodeEvent(encodeEvent(event)) as LogEvent;
    expect(decoded.metadata.sourceId).toBeUndefined();
    expect(decoded.metadata.sourceType).toBeUndefined();
  });

  it('round-trips every value kind, including integers beyond 2^53 and non-finite floats', () => {
    const fields = new Map<string, unknown>([
      ['null', null],
      ['true', true],
      ['false', false],
      ['bigPositive', 9_223_372_036_854_775_807n],
      ['bigNegative', -9_223_372_036_854_775_808n],
      ['nan', NaN],
      ['inf', Infinity],
      ['negInf', -Infinity],
      ['negZero', -0],
      ['str', 'hello \u{1f600}'],
      ['bytes', new Uint8Array([1, 2, 3, 255])],
      ['ts', Timestamp.fromNanos(-12345n)],
      ['arr', [1n, 'two', [3n]]],
      ['nested', new Map([['x', new Map([['y', 1n]])]])],
    ]) as unknown as Map<string, Value>;
    const event = new LogEvent(fields);
    const decoded = decodeEvent(encodeEvent(event)) as LogEvent;
    expect(valuesEqual(decoded.fields, event.fields)).toBe(true);
  });

  it('rejects a truncated buffer with a typed error', () => {
    const bytes = encodeEvent(LogEvent.fromMessage('x'));
    expect(() => decodeEvent(bytes.slice(0, bytes.length - 1))).toThrow(FerruleError);
  });

  it('rejects trailing garbage after a well-formed event', () => {
    const bytes = encodeEvent(LogEvent.fromMessage('x'));
    const withGarbage = new Uint8Array(bytes.length + 1);
    withGarbage.set(bytes);
    withGarbage[bytes.length] = 0xff;
    expect(() => decodeEvent(withGarbage)).toThrow(CodecMalformedError);
  });

  it('rejects an unsupported format version', () => {
    const bytes = encodeEvent(LogEvent.fromMessage('x'));
    const modified = bytes.slice();
    modified[0] = 99;
    expect(() => decodeEvent(modified)).toThrow(CodecVersionError);
  });

  it('rejects an unknown event kind byte', () => {
    const bytes = encodeEvent(LogEvent.fromMessage('x'));
    const modified = bytes.slice();
    modified[1] = 200;
    expect(() => decodeEvent(modified)).toThrow(CodecMalformedError);
  });

  it('rejects an unknown value tag', () => {
    const event = LogEvent.from({ a: 1 });
    const bytes = encodeEvent(event);
    // Find the tag byte for the integer field (comes right after the field name "a").
    const modified = bytes.slice();
    const marker = modified.indexOf(0x03); // TAG_INTEGER
    expect(marker).toBeGreaterThan(-1);
    modified[marker] = 200;
    expect(() => decodeEvent(modified)).toThrow(CodecMalformedError);
  });

  it('enforces maxDepth on nested arrays', () => {
    let value: unknown = 1n;
    for (let i = 0; i < 10; i++) value = [value];
    const event = LogEvent.from({ nested: value });
    const bytes = encodeEvent(event);
    expect(() => decodeEvent(bytes, { maxDepth: 3 })).toThrow(CodecLimitExceededError);
    expect(decodeEvent(bytes, { maxDepth: 20 })).toBeInstanceOf(LogEvent);
  });

  it('enforces maxStringBytes', () => {
    const event = LogEvent.from({ s: 'x'.repeat(100) });
    const bytes = encodeEvent(event);
    expect(() => decodeEvent(bytes, { maxStringBytes: 10 })).toThrow(CodecLimitExceededError);
  });

  it('enforces maxCollectionLength on arrays', () => {
    const event = LogEvent.from({ arr: Array.from({ length: 50 }, (_, i) => i) });
    const bytes = encodeEvent(event);
    expect(() => decodeEvent(bytes, { maxCollectionLength: 10 })).toThrow(CodecLimitExceededError);
  });

  it('never throws anything but a FerruleError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (bytes) => {
        try {
          decodeEvent(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(FerruleError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never throws anything but a FerruleError on mutated valid encodings', () => {
    fc.assert(
      fc.property(arbEvent, fc.nat(), fc.nat({ max: 255 }), (event, indexSeed, byteValue) => {
        const bytes = encodeEvent(event).slice();
        if (bytes.length === 0) return;
        const index = indexSeed % bytes.length;
        bytes[index] = byteValue;
        try {
          decodeEvent(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(FerruleError);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('encodeEventBatch / decodeEventBatch', () => {
  it('round-trips an empty batch', () => {
    expect(decodeEventBatch(encodeEventBatch([]))).toEqual([]);
  });

  it('round-trips a mixed batch of event kinds losslessly (property)', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 20 }), (events) => {
        const decoded = decodeEventBatch(encodeEventBatch(events));
        expect(decoded.length).toBe(events.length);
        for (let i = 0; i < events.length; i++) {
          expect(eventsEqual(decoded[i]!, events[i]!)).toBe(true);
        }
      }),
    );
  });

  it('enforces maxCollectionLength on the batch count itself', () => {
    const bytes = encodeEventBatch([LogEvent.fromMessage('a'), LogEvent.fromMessage('b')]);
    expect(() => decodeEventBatch(bytes, { maxCollectionLength: 1 })).toThrow(
      CodecLimitExceededError,
    );
  });

  it('never throws anything but a FerruleError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        try {
          decodeEventBatch(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(FerruleError);
        }
      }),
      { numRuns: 500 },
    );
  });
});
