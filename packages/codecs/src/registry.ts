import {
  encodeJson,
  FerruleError,
  fromPlain,
  LogEvent,
  MetricEvent,
  parseJson,
  SpanEvent,
  utf8Decode,
  utf8Encode,
  type Event,
  type JsonEncodeOptions,
  type JsonParseOptions,
  type ValueMap,
} from '@ferrule/core';
import { UnknownCodecError } from './errors.js';
import {
  decodeCsvToLogEvents,
  encodeLogEventsAsCsv,
  type CsvLogDecodeOptions,
  type CsvLogEncodeOptions,
} from './text/csv.js';
import {
  decodeLogfmtToLogEvent,
  encodeLogEventAsLogfmt,
  type LogfmtDecodeOptions,
  type LogfmtEncodeOptions,
} from './text/logfmt.js';
import { decodeExportLogsServiceRequest, encodeExportLogsServiceRequest } from './otlp/logs.js';
import {
  decodeExportMetricsServiceRequest,
  encodeExportMetricsServiceRequest,
} from './otlp/metrics.js';
import { decodeExportTraceServiceRequest, encodeExportTraceServiceRequest } from './otlp/traces.js';
import {
  decodeOtlpJsonLogs,
  decodeOtlpJsonMetrics,
  decodeOtlpJsonTraces,
  encodeOtlpJsonLogs,
  encodeOtlpJsonMetrics,
  encodeOtlpJsonTraces,
} from './otlp/json.js';
import type { OtlpDecodeOptions } from './otlp/common.js';
import {
  decodePrometheusText,
  encodePrometheusText,
  type PrometheusDecodeOptions,
  type PrometheusEncodeOptions,
} from './prometheus/text.js';
import {
  decodeStatsdToMetricEvents,
  encodeMetricEventsAsStatsdPacket,
  type StatsdDecodeOptions,
} from './statsd/statsd.js';
import {
  decodeSyslogAuto,
  encodeLogEventAsSyslog5424,
  type SyslogAutoDecodeOptions,
} from './syslog/index.js';
import {
  builtinPatterns,
  type CompiledPattern,
  type PatternCompileOptions,
  type PatternRegistry,
} from './patterns/index.js';

/**
 * Decodes bytes (one frame — a line, a whole request body, a whole document, depending on the
 * codec) into zero or more events. Implementations throw a typed `FerruleError` (never anything
 * else) on malformed input; see {@link decodeFrames} for collecting per-frame errors across many
 * frames instead of aborting on the first one.
 */
export interface Decoder {
  readonly name: string;
  decode(frame: Uint8Array): Event[];
}

/** Encodes events to bytes. `encode` handles one event at a time; codecs where batching several
 * events into one frame matters (OTLP requests, Prometheus text, CSV with a header) also provide
 * `encodeBatch`, which callers should prefer when encoding more than one event at once. */
export interface Encoder {
  readonly name: string;
  encode(event: Event): Uint8Array;
  encodeBatch?(events: readonly Event[]): Uint8Array;
}

/** One frame's decoding failure, as collected by {@link decodeFrames}. */
export interface FrameDecodeError {
  frameIndex: number;
  error: FerruleError;
}

export interface DecodeManyResult {
  events: Event[];
  errors: FrameDecodeError[];
}

/** Decodes every frame with `decoder`, collecting per-frame errors instead of throwing on the
 * first bad frame (a non-`FerruleError` throw still propagates, since that signals a bug rather
 * than malformed input). */
export function decodeFrames(decoder: Decoder, frames: readonly Uint8Array[]): DecodeManyResult {
  const events: Event[] = [];
  const errors: FrameDecodeError[] = [];
  for (let i = 0; i < frames.length; i++) {
    try {
      events.push(...decoder.decode(frames[i]!));
    } catch (error) {
      if (error instanceof FerruleError) errors.push({ frameIndex: i, error });
      else throw error;
    }
  }
  return { events, errors };
}

/** A named, registrable codec: a factory for a {@link Decoder} and/or an {@link Encoder}, each
 * configured by its own typed options object. */
export interface Codec<DecodeOptions = unknown, EncodeOptions = unknown> {
  readonly name: string;
  createDecoder?(options?: DecodeOptions): Decoder;
  createEncoder?(options?: EncodeOptions): Encoder;
}

/**
 * A collection of named codecs, so sources and sinks can select one by a configuration string
 * (`decoding: json` in a pipeline file) rather than importing modules directly.
 * {@link defaultCodecs} is pre-populated with every codec this package ships.
 */
export class CodecRegistry {
  private readonly codecs = new Map<string, Codec>();

  register(codec: Codec): this {
    this.codecs.set(codec.name, codec);
    return this;
  }

  get(name: string): Codec | undefined {
    return this.codecs.get(name);
  }

  names(): string[] {
    return [...this.codecs.keys()];
  }

  createDecoder(name: string, options?: unknown): Decoder {
    const codec = this.require(name);
    if (codec.createDecoder === undefined) {
      throw new FerruleError('E_CODEC_NO_DECODER', `codec ${JSON.stringify(name)} has no decoder`);
    }
    return codec.createDecoder(options);
  }

  createEncoder(name: string, options?: unknown): Encoder {
    const codec = this.require(name);
    if (codec.createEncoder === undefined) {
      throw new FerruleError('E_CODEC_NO_ENCODER', `codec ${JSON.stringify(name)} has no encoder`);
    }
    return codec.createEncoder(options);
  }

  private require(name: string): Codec {
    const codec = this.codecs.get(name);
    if (codec === undefined) throw new UnknownCodecError(name);
    return codec;
  }
}

function asLogEvents(value: unknown): LogEvent[] {
  if (value instanceof Map) return [new LogEvent(value as ValueMap)];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!(item instanceof Map)) {
        throw new FerruleError('E_JSON_SHAPE', 'expected an array of JSON objects');
      }
      return new LogEvent(item as ValueMap);
    });
  }
  throw new FerruleError('E_JSON_SHAPE', 'expected a JSON object or an array of JSON objects');
}

// --- json / ndjson --------------------------------------------------------------------------

export interface JsonCodecOptions {
  parse?: JsonParseOptions;
  encode?: JsonEncodeOptions;
}

const jsonCodec: Codec<JsonCodecOptions, JsonCodecOptions> = {
  name: 'json',
  createDecoder: (options = {}) => ({
    name: 'json',
    decode: (frame) => asLogEvents(parseJson(utf8Decode(frame, 'lossy'), options.parse)),
  }),
  createEncoder: (options = {}) => ({
    name: 'json',
    encode: (event) => utf8Encode(encodeJson(toEncodable(event), options.encode)),
  }),
};

const ndjsonCodec: Codec<JsonCodecOptions, JsonCodecOptions> = {
  name: 'ndjson',
  createDecoder: (options = {}) => ({
    name: 'ndjson',
    decode: (frame) => {
      const text = utf8Decode(frame, 'lossy').trim();
      if (text === '') return [];
      return asLogEvents(parseJson(text, options.parse));
    },
  }),
  createEncoder: (options = {}) => ({
    name: 'ndjson',
    encode: (event) => utf8Encode(encodeJson(toEncodable(event), options.encode)),
  }),
};

function toEncodable(event: Event): ValueMap {
  if (event instanceof LogEvent) return event.fields;
  return fromPlain(eventSummary(event)) as ValueMap;
}

function eventSummary(event: Event): Record<string, unknown> {
  if (event instanceof MetricEvent) {
    return {
      name: event.name,
      tags: Object.fromEntries(event.tags),
      kind: event.metricKind,
      value: event.value,
    };
  }
  const span = event as SpanEvent;
  return { traceId: span.traceIdHex, spanId: span.spanIdHex, name: span.name, status: span.status };
}

// --- text -------------------------------------------------------------------------------------

export interface TextCodecOptions {
  mode?: 'lossy' | 'strict';
  field?: string;
}

const textCodec: Codec<TextCodecOptions, TextCodecOptions> = {
  name: 'text',
  createDecoder: (options = {}) => ({
    name: 'text',
    decode: (frame) => [LogEvent.fromMessage(utf8Decode(frame, options.mode ?? 'lossy'))],
  }),
  createEncoder: (options = {}) => ({
    name: 'text',
    encode: (event) => {
      const field = options.field ?? 'message';
      const message = event instanceof LogEvent ? event.get(field) : undefined;
      return utf8Encode(typeof message === 'string' ? message : '');
    },
  }),
};

// --- logfmt -------------------------------------------------------------------------------------

const logfmtCodec: Codec<LogfmtDecodeOptions, LogfmtEncodeOptions> = {
  name: 'logfmt',
  createDecoder: (options = {}) => ({
    name: 'logfmt',
    decode: (frame) => [decodeLogfmtToLogEvent(utf8Decode(frame, 'lossy'), options)],
  }),
  createEncoder: (options = {}) => ({
    name: 'logfmt',
    encode: (event) =>
      utf8Encode(event instanceof LogEvent ? encodeLogEventAsLogfmt(event, options) : ''),
  }),
};

// --- csv ----------------------------------------------------------------------------------------

const csvCodec: Codec<CsvLogDecodeOptions, CsvLogEncodeOptions & { columns: readonly string[] }> = {
  name: 'csv',
  createDecoder: (options = {}) => ({
    name: 'csv',
    decode: (frame) => decodeCsvToLogEvents(utf8Decode(frame, 'lossy'), options),
  }),
  createEncoder: (options) => {
    const columns = options?.columns ?? [];
    return {
      name: 'csv',
      encode: (event) =>
        utf8Encode(
          event instanceof LogEvent ? encodeLogEventsAsCsv([event], columns, options) : '',
        ),
      encodeBatch: (events) =>
        utf8Encode(
          encodeLogEventsAsCsv(
            events.filter((e): e is LogEvent => e instanceof LogEvent),
            columns,
            options,
          ),
        ),
    };
  },
};

// --- syslog -------------------------------------------------------------------------------------

const syslogCodec: Codec<SyslogAutoDecodeOptions, Record<string, never>> = {
  name: 'syslog',
  createDecoder: (options = {}) => ({
    name: 'syslog',
    decode: (frame) => [decodeSyslogAuto(utf8Decode(frame, 'lossy'), options)],
  }),
  createEncoder: () => ({
    name: 'syslog',
    encode: (event) =>
      utf8Encode(event instanceof LogEvent ? encodeLogEventAsSyslog5424(event) : ''),
  }),
};

// --- OTLP protobuf --------------------------------------------------------------------------

export type OtlpSignal = 'logs' | 'metrics' | 'traces';

export interface OtlpProtobufCodecOptions extends OtlpDecodeOptions {
  signal: OtlpSignal;
}

const otlpProtobufCodec: Codec<OtlpProtobufCodecOptions, OtlpProtobufCodecOptions> = {
  name: 'otlp_protobuf',
  createDecoder: (options) => {
    const signal = options?.signal ?? 'logs';
    return {
      name: 'otlp_protobuf',
      decode: (frame) => {
        switch (signal) {
          case 'logs':
            return decodeExportLogsServiceRequest(frame, options);
          case 'metrics':
            return decodeExportMetricsServiceRequest(frame, options);
          case 'traces':
            return decodeExportTraceServiceRequest(frame, options);
        }
      },
    };
  },
  createEncoder: (options) => {
    const signal = options?.signal ?? 'logs';
    return {
      name: 'otlp_protobuf',
      encode: (event) => encodeOne(signal, event),
      encodeBatch: (events) => encodeBatchBySignal(signal, events),
    };
  },
};

function encodeOne(signal: OtlpSignal, event: Event): Uint8Array {
  switch (signal) {
    case 'logs':
      return encodeExportLogsServiceRequest(event instanceof LogEvent ? [event] : []);
    case 'metrics':
      return encodeExportMetricsServiceRequest(event instanceof MetricEvent ? [event] : []);
    case 'traces':
      return encodeExportTraceServiceRequest(event instanceof SpanEvent ? [event] : []);
  }
}

function encodeBatchBySignal(signal: OtlpSignal, events: readonly Event[]): Uint8Array {
  switch (signal) {
    case 'logs':
      return encodeExportLogsServiceRequest(
        events.filter((e): e is LogEvent => e instanceof LogEvent),
      );
    case 'metrics':
      return encodeExportMetricsServiceRequest(
        events.filter((e): e is MetricEvent => e instanceof MetricEvent),
      );
    case 'traces':
      return encodeExportTraceServiceRequest(
        events.filter((e): e is SpanEvent => e instanceof SpanEvent),
      );
  }
}

// --- OTLP JSON ------------------------------------------------------------------------------

const otlpJsonCodec: Codec<OtlpProtobufCodecOptions, OtlpProtobufCodecOptions> = {
  name: 'otlp_json',
  createDecoder: (options) => {
    const signal = options?.signal ?? 'logs';
    return {
      name: 'otlp_json',
      decode: (frame) => {
        const text = utf8Decode(frame, 'lossy');
        switch (signal) {
          case 'logs':
            return decodeOtlpJsonLogs(text, options);
          case 'metrics':
            return decodeOtlpJsonMetrics(text, options);
          case 'traces':
            return decodeOtlpJsonTraces(text, options);
        }
      },
    };
  },
  createEncoder: (options) => {
    const signal = options?.signal ?? 'logs';
    const encodeManyJson = (events: readonly Event[]): Uint8Array => {
      switch (signal) {
        case 'logs':
          return utf8Encode(
            encodeOtlpJsonLogs(events.filter((e): e is LogEvent => e instanceof LogEvent)),
          );
        case 'metrics':
          return utf8Encode(
            encodeOtlpJsonMetrics(events.filter((e): e is MetricEvent => e instanceof MetricEvent)),
          );
        case 'traces':
          return utf8Encode(
            encodeOtlpJsonTraces(events.filter((e): e is SpanEvent => e instanceof SpanEvent)),
          );
      }
    };
    return {
      name: 'otlp_json',
      encode: (event) => encodeManyJson([event]),
      encodeBatch: encodeManyJson,
    };
  },
};

// --- Prometheus text ------------------------------------------------------------------------

const prometheusTextCodec: Codec<PrometheusDecodeOptions, PrometheusEncodeOptions> = {
  name: 'prometheus_text',
  createDecoder: (options = {}) => ({
    name: 'prometheus_text',
    decode: (frame) => decodePrometheusText(utf8Decode(frame, 'lossy'), options),
  }),
  createEncoder: (options = {}) => {
    const encodeMany = (events: readonly Event[]): Uint8Array =>
      utf8Encode(
        encodePrometheusText(
          events.filter((e): e is MetricEvent => e instanceof MetricEvent),
          options,
        ),
      );
    return {
      name: 'prometheus_text',
      encode: (event) => encodeMany([event]),
      encodeBatch: encodeMany,
    };
  },
};

// --- StatsD ---------------------------------------------------------------------------------

const statsdCodec: Codec<StatsdDecodeOptions, Record<string, never>> = {
  name: 'statsd',
  createDecoder: (options = {}) => ({
    name: 'statsd',
    decode: (frame) => decodeStatsdToMetricEvents(utf8Decode(frame, 'lossy'), options),
  }),
  createEncoder: () => {
    const encodeMany = (events: readonly Event[]): Uint8Array =>
      utf8Encode(
        encodeMetricEventsAsStatsdPacket(
          events.filter((e): e is MetricEvent => e instanceof MetricEvent),
        ),
      );
    return { name: 'statsd', encode: (event) => encodeMany([event]), encodeBatch: encodeMany };
  },
};

// --- pattern ----------------------------------------------------------------------------------

export interface PatternCodecOptions extends PatternCompileOptions {
  /** The pattern to compile (a mix of literal regex syntax and `%{NAME}` references). */
  pattern: string;
  /** Pattern registry to resolve `%{NAME}` references against. Default {@link builtinPatterns}. */
  registry?: PatternRegistry;
}

const patternCodec: Codec<PatternCodecOptions, never> = {
  name: 'pattern',
  createDecoder: (options) => {
    if (options === undefined) {
      throw new FerruleError('E_CODEC_OPTIONS', 'the "pattern" codec requires a `pattern` option');
    }
    const registry = options.registry ?? builtinPatterns;
    const compiled: CompiledPattern = registry.compile(options.pattern, options);
    return {
      name: 'pattern',
      decode: (frame) => [compiled.decode(utf8Decode(frame, 'lossy'))],
    };
  },
};

/** Every codec this package ships, keyed by name: `json`, `ndjson`, `text`, `logfmt`, `csv`,
 * `syslog`, `otlp_protobuf`, `otlp_json`, `prometheus_text`, `statsd`, `pattern`. */
export const defaultCodecs = new CodecRegistry();
for (const codec of [
  jsonCodec,
  ndjsonCodec,
  textCodec,
  logfmtCodec,
  csvCodec,
  syslogCodec,
  otlpProtobufCodec,
  otlpJsonCodec,
  prometheusTextCodec,
  statsdCodec,
  patternCodec,
]) {
  defaultCodecs.register(codec);
}
