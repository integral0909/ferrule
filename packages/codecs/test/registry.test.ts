import { describe, expect, it } from 'vitest';
import { LogEvent, MetricEvent, SpanEvent, Timestamp, utf8Decode, utf8Encode } from '@ferrule/core';
import {
  CodecRegistry,
  decodeFrames,
  defaultCodecs,
  UnknownCodecError,
  type Codec,
  type Decoder,
} from '@ferrule/codecs';

describe('defaultCodecs', () => {
  it('registers every documented codec name', () => {
    expect(new Set(defaultCodecs.names())).toEqual(
      new Set([
        'json',
        'ndjson',
        'text',
        'logfmt',
        'csv',
        'syslog',
        'otlp_protobuf',
        'otlp_json',
        'prometheus_text',
        'statsd',
        'pattern',
      ]),
    );
  });

  it('throws UnknownCodecError for an unregistered name', () => {
    expect(() => defaultCodecs.createDecoder('nope')).toThrow(UnknownCodecError);
    expect(() => defaultCodecs.createEncoder('nope')).toThrow(UnknownCodecError);
  });

  it('throws when a codec has no decoder or no encoder', () => {
    const pattern = defaultCodecs.get('pattern')!;
    expect(pattern.createEncoder).toBeUndefined();
    expect(() => defaultCodecs.createEncoder('pattern')).toThrow(/no encoder/);
  });

  describe('json', () => {
    it('decodes a JSON object frame into one LogEvent', () => {
      const decoder = defaultCodecs.createDecoder('json');
      const [event] = decoder.decode(utf8Encode('{"a":1,"b":"x"}'));
      expect(event).toBeInstanceOf(LogEvent);
      expect((event as LogEvent).get('a')).toBe(1n);
      expect((event as LogEvent).get('b')).toBe('x');
    });

    it('decodes a JSON array of objects into multiple LogEvents', () => {
      const decoder = defaultCodecs.createDecoder('json');
      const events = decoder.decode(utf8Encode('[{"a":1},{"a":2}]'));
      expect(events).toHaveLength(2);
    });

    it('encodes a LogEvent back to JSON', () => {
      const encoder = defaultCodecs.createEncoder('json');
      const bytes = encoder.encode(LogEvent.from({ a: 1 }));
      expect(utf8Decode(bytes, 'strict')).toBe('{"a":1}');
    });

    it('rejects a JSON scalar with no fields', () => {
      const decoder = defaultCodecs.createDecoder('json');
      expect(() => decoder.decode(utf8Encode('"just a string"'))).toThrow();
    });
  });

  describe('ndjson', () => {
    it('decodes one line into one LogEvent and skips blank frames', () => {
      const decoder = defaultCodecs.createDecoder('ndjson');
      expect(decoder.decode(utf8Encode('{"a":1}'))).toHaveLength(1);
      expect(decoder.decode(utf8Encode(''))).toEqual([]);
      expect(decoder.decode(utf8Encode('   '))).toEqual([]);
    });
  });

  describe('text', () => {
    it('wraps the frame as a message field', () => {
      const decoder = defaultCodecs.createDecoder('text');
      const [event] = decoder.decode(utf8Encode('hello there'));
      expect((event as LogEvent).get('message')).toBe('hello there');
    });

    it('encodes the message field back to bytes', () => {
      const encoder = defaultCodecs.createEncoder('text');
      const bytes = encoder.encode(LogEvent.fromMessage('hi'));
      expect(utf8Decode(bytes, 'strict')).toBe('hi');
    });
  });

  describe('logfmt', () => {
    it('round-trips through decode/encode', () => {
      const decoder = defaultCodecs.createDecoder('logfmt');
      const encoder = defaultCodecs.createEncoder('logfmt');
      const [event] = decoder.decode(utf8Encode('a=1 b=2'));
      const reencoded = encoder.encode(event!);
      expect(utf8Decode(reencoded, 'strict')).toBe('a=1 b=2');
    });
  });

  describe('csv', () => {
    it('decodes a whole document into several LogEvents', () => {
      const decoder = defaultCodecs.createDecoder('csv');
      const events = decoder.decode(utf8Encode('name,age\nalice,30\nbob,25\n'));
      expect(events).toHaveLength(2);
      expect((events[0] as LogEvent).get('name')).toBe('alice');
    });

    it('encodeBatch emits a single document with one header', () => {
      const encoder = defaultCodecs.createEncoder('csv', { columns: ['name'] });
      const bytes = encoder.encodeBatch!([
        LogEvent.from({ name: 'a' }),
        LogEvent.from({ name: 'b' }),
      ]);
      const text = utf8Decode(bytes, 'strict');
      expect(text.match(/name/g)).toHaveLength(1);
      expect(text).toContain('a\r\n');
      expect(text).toContain('b\r\n');
    });
  });

  describe('syslog', () => {
    it('auto-detects and decodes an RFC 5424 line', () => {
      const decoder = defaultCodecs.createDecoder('syslog');
      const [event] = decoder.decode(utf8Encode('<34>1 2003-10-11T22:14:15Z host app - - - hi'));
      expect((event as LogEvent).get('hostname')).toBe('host');
    });

    it('encodes a LogEvent as RFC 5424', () => {
      const encoder = defaultCodecs.createEncoder('syslog');
      const bytes = encoder.encode(LogEvent.fromMessage('hi'));
      expect(utf8Decode(bytes, 'strict')).toContain('hi');
    });
  });

  describe('otlp_protobuf', () => {
    it('round-trips a single log event', () => {
      const encoder = defaultCodecs.createEncoder('otlp_protobuf', { signal: 'logs' });
      const decoder = defaultCodecs.createDecoder('otlp_protobuf', { signal: 'logs' });
      const bytes = encoder.encode(LogEvent.fromMessage('hi'));
      const [event] = decoder.decode(bytes);
      expect((event as LogEvent).get('message')).toBe('hi');
    });

    it('round-trips a batch of metrics via encodeBatch', () => {
      const encoder = defaultCodecs.createEncoder('otlp_protobuf', { signal: 'metrics' });
      const decoder = defaultCodecs.createDecoder('otlp_protobuf', { signal: 'metrics' });
      const events = [
        new MetricEvent({
          name: 'a',
          tags: new Map(),
          kind: 'absolute',
          value: { type: 'gauge', value: 1 },
        }),
        new MetricEvent({
          name: 'b',
          tags: new Map(),
          kind: 'absolute',
          value: { type: 'gauge', value: 2 },
        }),
      ];
      const bytes = encoder.encodeBatch!(events);
      const decoded = decoder.decode(bytes);
      expect(decoded).toHaveLength(2);
    });

    it('round-trips a span', () => {
      const encoder = defaultCodecs.createEncoder('otlp_protobuf', { signal: 'traces' });
      const decoder = defaultCodecs.createDecoder('otlp_protobuf', { signal: 'traces' });
      const span = new SpanEvent({
        traceId: new Uint8Array(16).fill(1),
        spanId: new Uint8Array(8).fill(2),
        name: 'op',
        startTime: Timestamp.fromMillis(1),
        endTime: Timestamp.fromMillis(2),
      });
      const [decoded] = decoder.decode(encoder.encode(span));
      expect((decoded as SpanEvent).name).toBe('op');
    });

    it('filters out events of the wrong kind rather than throwing', () => {
      const encoder = defaultCodecs.createEncoder('otlp_protobuf', { signal: 'logs' });
      const bytes = encoder.encode(
        new MetricEvent({
          name: 'x',
          tags: new Map(),
          kind: 'absolute',
          value: { type: 'gauge', value: 1 },
        }),
      );
      const decoder = defaultCodecs.createDecoder('otlp_protobuf', { signal: 'logs' });
      expect(decoder.decode(bytes)).toEqual([]);
    });
  });

  describe('otlp_json', () => {
    it('round-trips a single log event as JSON text', () => {
      const encoder = defaultCodecs.createEncoder('otlp_json', { signal: 'logs' });
      const decoder = defaultCodecs.createDecoder('otlp_json', { signal: 'logs' });
      const bytes = encoder.encode(LogEvent.fromMessage('hi'));
      expect(() => {
        JSON.parse(utf8Decode(bytes, 'strict'));
      }).not.toThrow();
      const [event] = decoder.decode(bytes);
      expect((event as LogEvent).get('message')).toBe('hi');
    });
  });

  describe('prometheus_text', () => {
    it('encodeBatch groups TYPE lines and decode reassembles MetricEvents', () => {
      const encoder = defaultCodecs.createEncoder('prometheus_text');
      const decoder = defaultCodecs.createDecoder('prometheus_text');
      const events = [
        new MetricEvent({
          name: 'reqs',
          tags: new Map(),
          kind: 'absolute',
          value: { type: 'counter', value: 5 },
        }),
      ];
      const bytes = encoder.encodeBatch!(events);
      const decoded = decoder.decode(bytes);
      expect((decoded[0] as MetricEvent).value).toEqual({ type: 'counter', value: 5 });
    });
  });

  describe('statsd', () => {
    it('decodes a packet into MetricEvents', () => {
      const decoder = defaultCodecs.createDecoder('statsd');
      const events = decoder.decode(utf8Encode('reqs:1|c\n'));
      expect((events[0] as MetricEvent).name).toBe('reqs');
    });

    it('encodeBatch emits one packet with a line per event', () => {
      const encoder = defaultCodecs.createEncoder('statsd');
      const events = [
        new MetricEvent({
          name: 'a',
          tags: new Map(),
          kind: 'incremental',
          value: { type: 'counter', value: 3 },
        }),
        new MetricEvent({
          name: 'b',
          tags: new Map(),
          kind: 'absolute',
          value: { type: 'gauge', value: 5 },
        }),
      ];
      const text = utf8Decode(encoder.encodeBatch!(events), 'strict');
      expect(text).toBe('a:3|c\nb:5|g\n');
    });
  });

  describe('pattern', () => {
    it('compiles once at creation and decodes matching frames', () => {
      const decoder = defaultCodecs.createDecoder('pattern', { pattern: '%{WORD:w} %{INT:n:int}' });
      const [event] = decoder.decode(utf8Encode('hello 42'));
      expect((event as LogEvent).get('w')).toBe('hello');
      expect((event as LogEvent).get('n')).toBe(42n);
    });

    it('requires a pattern option', () => {
      expect(() => defaultCodecs.createDecoder('pattern')).toThrow();
    });
  });
});

describe('decodeFrames', () => {
  it('collects per-frame errors instead of aborting on the first bad frame', () => {
    const decoder = defaultCodecs.createDecoder('json');
    const frames = [utf8Encode('{"a":1}'), utf8Encode('not json'), utf8Encode('{"a":2}')];
    const { events, errors } = decodeFrames(decoder, frames);
    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.frameIndex).toBe(1);
    expect(errors[0]!.error).toHaveProperty('code');
  });

  it('returns no errors when every frame decodes cleanly', () => {
    const decoder = defaultCodecs.createDecoder('logfmt');
    const { events, errors } = decodeFrames(decoder, [utf8Encode('a=1'), utf8Encode('b=2')]);
    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });
});

describe('CodecRegistry', () => {
  it('supports registering a custom codec independently of defaultCodecs', () => {
    const registry = new CodecRegistry();
    const custom: Codec = {
      name: 'shout',
      createDecoder: (): Decoder => ({
        name: 'shout',
        decode: (frame) => [LogEvent.fromMessage(utf8Decode(frame, 'lossy').toUpperCase())],
      }),
    };
    registry.register(custom);
    expect(registry.names()).toEqual(['shout']);
    const decoder = registry.createDecoder('shout');
    const [event] = decoder.decode(utf8Encode('hi'));
    expect((event as LogEvent).get('message')).toBe('HI');
    expect(registry.get('shout')).toBe(custom);
    expect(registry.get('missing')).toBeUndefined();
  });
});
