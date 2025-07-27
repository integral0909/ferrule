import { describe, expect, it } from 'vitest';
import {
  concatBytes,
  LogEvent,
  MetricEvent,
  SpanEvent,
  Timestamp,
  utf8Decode,
  utf8Encode,
} from '@ferrule/core';
import {
  decodeFrames,
  defaultCodecs,
  encodeExportLogsServiceRequest,
  LengthPrefixedFramer,
  NewlineFramer,
  OctetCountingFramer,
  type Framer,
} from '@ferrule/codecs';

/** Feeds `chunks` through `framer` the way a real source would, returning every frame produced. */
function frame(framer: Framer, chunks: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const chunk of chunks) out.push(...framer.push(chunk));
  out.push(...framer.finish());
  return out;
}

describe('framer + codec composition, as a source or sink would use them', () => {
  it('NDJSON over the wire: NewlineFramer splits records, the ndjson codec decodes each one', () => {
    const wireBytes = utf8Encode('{"a":1}\n{"a":2}\n{"a":3}\n');
    // A real source would see this arrive in arbitrarily sized TCP reads; split it awkwardly here.
    const chunks = [wireBytes.slice(0, 5), wireBytes.slice(5, 12), wireBytes.slice(12)];
    const frames = frame(new NewlineFramer(), chunks);
    expect(frames).toHaveLength(3);

    const decoder = defaultCodecs.createDecoder('ndjson');
    const { events, errors } = decodeFrames(decoder, frames);
    expect(errors).toHaveLength(0);
    expect(events.map((e) => (e as LogEvent).get('a'))).toEqual([1n, 2n, 3n]);
  });

  it('one malformed line among several does not stop the rest from decoding', () => {
    const wireBytes = utf8Encode('{"a":1}\nnot json\n{"a":3}\n');
    const frames = frame(new NewlineFramer(), [wireBytes]);
    const decoder = defaultCodecs.createDecoder('json');
    const { events, errors } = decodeFrames(decoder, frames);
    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.frameIndex).toBe(1);
  });

  it('logfmt records over a length-prefixed binary protocol', () => {
    const records = [
      'level=info msg=start',
      'level=warn msg="disk low" pct=91',
      'level=info msg=stop',
    ];
    const wire: Uint8Array[] = [];
    for (const r of records) {
      const body = utf8Encode(r);
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, body.length, false);
      wire.push(header, body);
    }
    const wireBytes = concatBytes(wire);
    const framer = new LengthPrefixedFramer();
    // Simulate a single read that happens to land mid-record.
    const midpoint = Math.floor(wireBytes.length / 2);
    const frames = frame(framer, [wireBytes.slice(0, midpoint), wireBytes.slice(midpoint)]);
    expect(frames).toHaveLength(3);

    const decoder = defaultCodecs.createDecoder('logfmt');
    const events = frames.flatMap((f) => decoder.decode(f)) as LogEvent[];
    expect(events.map((e) => e.get('level'))).toEqual(['info', 'warn', 'info']);
    expect(events[1]!.get('msg')).toBe('disk low');
  });

  it('syslog over RFC 6587 octet-counting, decoded with the syslog codec', () => {
    const messages = [
      '<34>1 2024-01-01T00:00:00Z host app - - - first',
      '<34>1 2024-01-01T00:00:01Z host app - - - second',
    ];
    const packet = messages.map((m) => `${utf8Encode(m).length} ${m}`).join('');
    const frames = frame(new OctetCountingFramer(), [utf8Encode(packet)]);
    expect(frames).toHaveLength(2);

    const decoder = defaultCodecs.createDecoder('syslog');
    const events = frames.flatMap((f) => decoder.decode(f)) as LogEvent[];
    expect(events.map((e) => e.get('message'))).toEqual(['first', 'second']);
  });

  it('CSV export decoded as a whole frame, one LogEvent per row, then re-encoded', () => {
    const decoder = defaultCodecs.createDecoder('csv');
    const encoder = defaultCodecs.createEncoder('csv', { columns: ['user', 'action'] });
    const doc = utf8Encode('user,action\nalice,login\nbob,logout\n');
    const events = decoder.decode(doc);
    expect(events).toHaveLength(2);
    const reencoded = utf8Decode(encoder.encodeBatch!(events), 'strict');
    expect(reencoded).toBe('user,action\r\nalice,login\r\nbob,logout\r\n');
  });

  it('an OTLP protobuf batch of mixed-looking events only yields the events for its own signal', () => {
    const logs = [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')];
    const bytes = encodeExportLogsServiceRequest(logs);
    const decoder = defaultCodecs.createDecoder('otlp_protobuf', { signal: 'logs' });
    const decoded = decoder.decode(bytes);
    expect(decoded).toHaveLength(2);
    expect(decoded.every((e) => e instanceof LogEvent)).toBe(true);
  });

  it('a full pipeline round trip: MetricEvents -> prometheus_text -> back to MetricEvents', () => {
    const events = [
      new MetricEvent({
        name: 'up',
        tags: new Map([['job', 'api']]),
        kind: 'absolute',
        value: { type: 'gauge', value: 1 },
      }),
      new MetricEvent({
        name: 'requests_total',
        tags: new Map(),
        kind: 'absolute',
        value: { type: 'counter', value: 42 },
      }),
    ];
    const encoder = defaultCodecs.createEncoder('prometheus_text');
    const decoder = defaultCodecs.createDecoder('prometheus_text');
    const text = encoder.encodeBatch!(events);
    const decoded = decoder.decode(text) as MetricEvent[];
    expect(decoded.map((e) => e.name).sort()).toEqual(['requests_total', 'up']);
  });

  it('a whole trace decodes and re-encodes with the same span identity', () => {
    const span = new SpanEvent({
      traceId: new Uint8Array(16).fill(5),
      spanId: new Uint8Array(8).fill(6),
      name: 'handle-request',
      startTime: Timestamp.fromMillis(1000),
      endTime: Timestamp.fromMillis(1050),
    });
    const encoder = defaultCodecs.createEncoder('otlp_protobuf', { signal: 'traces' });
    const decoder = defaultCodecs.createDecoder('otlp_protobuf', { signal: 'traces' });
    const [decoded] = decoder.decode(encoder.encode(span)) as SpanEvent[];
    expect(decoded!.traceIdHex).toBe(span.traceIdHex);
    expect(decoded!.name).toBe('handle-request');
  });
});
