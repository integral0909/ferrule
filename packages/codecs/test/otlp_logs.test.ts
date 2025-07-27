import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LogEvent, Timestamp, valuesEqual } from '@ferrule/core';
import { decodeExportLogsServiceRequest, encodeExportLogsServiceRequest } from '@ferrule/codecs';
import { arbLogEvent } from './arbitraries.js';

describe('OTLP logs protobuf round trip', () => {
  it('round-trips arbitrary log events as a multiset', () => {
    fc.assert(
      fc.property(fc.array(arbLogEvent, { minLength: 0, maxLength: 8 }), (events) => {
        const bytes = encodeExportLogsServiceRequest(events);
        const decoded = decodeExportLogsServiceRequest(bytes);
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
      { numRuns: 30 },
    );
  });

  it('maps body/message, severity, trace context, attributes, resource, and scope', () => {
    const event = new LogEvent(
      new Map<string, unknown>([
        ['timestamp', Timestamp.fromMillis(1_700_000_000_000)],
        ['severity_number', 9n],
        ['severity_text', 'INFO'],
        ['body', 'hello world'],
        ['message', 'hello world'],
        ['attributes', new Map([['http.method', 'GET']])],
        ['trace_id', new Uint8Array(16).fill(7)],
        ['span_id', new Uint8Array(8).fill(3)],
        ['resource', new Map([['service.name', 'checkout']])],
        [
          'scope',
          new Map<string, unknown>([
            ['name', 'my-lib'],
            ['version', '2.0'],
            ['attributes', new Map()],
          ]),
        ],
      ]) as never,
    );
    const bytes = encodeExportLogsServiceRequest([event]);
    const [decoded] = decodeExportLogsServiceRequest(bytes);
    expect(decoded).toBeDefined();
    expect(decoded!.get('message')).toBe('hello world');
    expect(decoded!.get('body')).toBe('hello world');
    expect(decoded!.get('severity_number')).toBe(9n);
    expect(decoded!.get('severity_text')).toBe('INFO');
    expect(decoded!.get('trace_id')).toEqual(new Uint8Array(16).fill(7));
    expect(decoded!.get('span_id')).toEqual(new Uint8Array(8).fill(3));
    expect(valuesEqual(decoded!.get('resource')!, new Map([['service.name', 'checkout']]))).toBe(
      true,
    );
    const scope = decoded!.get('scope');
    expect(scope instanceof Map && scope.get('name')).toBe('my-lib');
    expect(scope instanceof Map && scope.get('version')).toBe('2.0');
  });

  it('preserves a structured (non-string) body without setting .message', () => {
    const fields = new Map<string, unknown>([
      ['timestamp', Timestamp.fromMillis(1000)],
      ['body', new Map([['code', 42n]])],
    ]);
    const event = new LogEvent(fields as never);
    const bytes = encodeExportLogsServiceRequest([event]);
    const [decoded] = decodeExportLogsServiceRequest(bytes);
    expect(decoded!.has('message')).toBe(false);
    expect(valuesEqual(decoded!.get('body')!, new Map([['code', 42n]]))).toBe(true);
  });

  it('folds unmapped top-level fields into attributes on encode', () => {
    const fields = new Map<string, unknown>([
      ['timestamp', Timestamp.fromMillis(1000)],
      ['message', 'hi'],
      ['custom_field', 'custom_value'],
    ]);
    const event = new LogEvent(fields as never);
    const bytes = encodeExportLogsServiceRequest([event]);
    const [decoded] = decodeExportLogsServiceRequest(bytes);
    const attrs = decoded!.get('attributes');
    expect(attrs instanceof Map && attrs.get('custom_field')).toBe('custom_value');
  });

  it('decodes an empty request to an empty array', () => {
    expect(decodeExportLogsServiceRequest(new Uint8Array())).toEqual([]);
  });

  it('falls back to Timestamp.now() when neither time field is set', () => {
    const before = Timestamp.now();
    const event = LogEvent.fromMessage('no timestamp');
    event.remove('timestamp');
    const bytes = encodeExportLogsServiceRequest([event]);
    const [decoded] = decodeExportLogsServiceRequest(bytes);
    const ts = decoded!.get('timestamp');
    expect(ts instanceof Timestamp && !ts.isBefore(before)).toBe(true);
  });

  it('never throws anything but a FerruleError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (bytes) => {
        try {
          decodeExportLogsServiceRequest(bytes);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
      { numRuns: 200 },
    );
  });
});
