import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SpanEvent, Timestamp, ValueTypeError, valuesEqual } from '@ferrule/core';
import {
  decodeExportTraceServiceRequest,
  encodeExportTraceServiceRequest,
  ProtoReader,
  ProtoWriter,
} from '@ferrule/codecs';
import { arbSpanEvent } from './arbitraries.js';

function spansEqual(a: SpanEvent, b: SpanEvent): boolean {
  return (
    Buffer.from(a.traceId).equals(Buffer.from(b.traceId)) &&
    Buffer.from(a.spanId).equals(Buffer.from(b.spanId)) &&
    a.name === b.name &&
    a.spanKind === b.spanKind &&
    a.startTime.equals(b.startTime) &&
    a.endTime.equals(b.endTime) &&
    a.status.code === b.status.code &&
    (a.status.message ?? '') === (b.status.message ?? '') &&
    valuesEqual(a.attributes, b.attributes) &&
    valuesEqual(a.resource, b.resource) &&
    a.annotations.length === b.annotations.length &&
    a.links.length === b.links.length
  );
}

describe('OTLP traces protobuf round trip', () => {
  // Encoding groups spans by (resource, scope) into ResourceSpans/ScopeSpans, so spans with
  // differing resources interleaved with a repeated one are not guaranteed to come back in their
  // original order (this is valid OTLP: order across resource groups carries no meaning) — compare
  // as a multiset instead of pairwise by index.
  it('round-trips arbitrary spans through encode/decode as a multiset', () => {
    fc.assert(
      fc.property(fc.array(arbSpanEvent, { minLength: 0, maxLength: 8 }), (spans) => {
        const bytes = encodeExportTraceServiceRequest(spans);
        const decoded = decodeExportTraceServiceRequest(bytes);
        expect(decoded).toHaveLength(spans.length);
        const pool = [...decoded];
        for (const span of spans) {
          const idx = pool.findIndex((d) => spansEqual(d, span));
          expect(idx).toBeGreaterThanOrEqual(0);
          pool.splice(idx, 1);
        }
      }),
      { numRuns: 30 },
    );
  });

  it('preserves parentSpanId, traceState, annotations, and links', () => {
    const span = new SpanEvent({
      traceId: new Uint8Array(16).fill(1),
      spanId: new Uint8Array(8).fill(2),
      parentSpanId: new Uint8Array(8).fill(3),
      traceState: 'vendor=value',
      name: 'op',
      spanKind: 'server',
      startTime: Timestamp.fromMillis(1000),
      endTime: Timestamp.fromMillis(2000),
      status: { code: 'error', message: 'boom' },
      attributes: new Map([['http.method', 'GET']]),
      annotations: [
        { name: 'evt', time: Timestamp.fromMillis(1500), attributes: new Map([['k', 'v']]) },
      ],
      links: [
        {
          traceId: new Uint8Array(16).fill(9),
          spanId: new Uint8Array(8).fill(8),
          traceState: 'a=b',
          attributes: new Map([['link.attr', true]]),
        },
      ],
      resource: new Map([['service.name', 'svc']]),
      scope: { name: 'scope-name', version: '1.0', attributes: new Map() },
    });

    const bytes = encodeExportTraceServiceRequest([span]);
    const [decoded] = decodeExportTraceServiceRequest(bytes);
    expect(decoded).toBeDefined();
    expect(decoded!.parentSpanId).toEqual(span.parentSpanId);
    expect(decoded!.traceState).toBe('vendor=value');
    expect(decoded!.annotations).toHaveLength(1);
    expect(decoded!.annotations[0]!.name).toBe('evt');
    expect(decoded!.links).toHaveLength(1);
    expect(decoded!.links[0]!.traceState).toBe('a=b');
    expect(decoded!.scope?.name).toBe('scope-name');
    expect(decoded!.scope?.version).toBe('1.0');
    expect(decoded!.status).toEqual({ code: 'error', message: 'boom' });
  });

  it('groups spans sharing a resource and scope under one ResourceSpans/ScopeSpans', () => {
    const resource = new Map([['service.name', 'svc']]);
    const scope = { name: 'scope', attributes: new Map() };
    const spanA = new SpanEvent({
      traceId: new Uint8Array(16).fill(1),
      spanId: new Uint8Array(8).fill(1),
      name: 'a',
      startTime: Timestamp.fromMillis(0),
      endTime: Timestamp.fromMillis(1),
      resource,
      scope,
    });
    const spanB = new SpanEvent({
      traceId: new Uint8Array(16).fill(2),
      spanId: new Uint8Array(8).fill(2),
      name: 'b',
      startTime: Timestamp.fromMillis(0),
      endTime: Timestamp.fromMillis(1),
      resource,
      scope,
    });
    const bytes = encodeExportTraceServiceRequest([spanA, spanB]);
    let resourceSpansCount = 0;
    const r = new ProtoReader(bytes);
    while (!r.atEnd()) {
      r.readTag();
      resourceSpansCount++;
      r.readBytes();
    }
    expect(resourceSpansCount).toBe(1);
  });

  it('decodes an empty request to an empty array', () => {
    expect(decodeExportTraceServiceRequest(new Uint8Array())).toEqual([]);
  });

  it('raises a typed error for a malformed trace_id length instead of a generic throw', () => {
    // ResourceSpans{ scope_spans: [ ScopeSpans{ spans: [ Span{ trace_id: 4 bytes (invalid) } ] } ] }
    const spanBytes = new ProtoWriter();
    spanBytes.writeBytes(1, new Uint8Array(4)); // trace_id, wrong length
    spanBytes.writeBytes(2, new Uint8Array(8)); // span_id
    const scopeSpans = new ProtoWriter();
    scopeSpans.writeBytes(2, spanBytes.finish());
    const resourceSpans = new ProtoWriter();
    resourceSpans.writeBytes(2, scopeSpans.finish());
    const request = new ProtoWriter();
    request.writeBytes(1, resourceSpans.finish());
    expect(() => decodeExportTraceServiceRequest(request.finish())).toThrow(ValueTypeError);
  });

  it('never throws anything but a FerruleError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (bytes) => {
        try {
          decodeExportTraceServiceRequest(bytes);
        } catch (error) {
          expect(error).toHaveProperty('code');
        }
      }),
      { numRuns: 200 },
    );
  });
});
