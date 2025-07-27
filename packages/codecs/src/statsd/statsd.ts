import {
  createMetadata,
  LimitExceededError,
  MetricEvent,
  Timestamp,
  type MetricKind,
  type MetricValue,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyValue } from '../value_text.js';

const CODEC = 'statsd';

function fail(message: string, offset?: number): never {
  throw new CodecSyntaxError(CODEC, 'E_STATSD_SYNTAX', message, offset);
}

export type StatsdType = 'c' | 'g' | 'ms' | 'h' | 'd' | 's';

/** One decoded StatsD/DogStatsD line. `value` is the numeric value for every type except `s`
 * (set), where `setMember` carries the (arbitrary-string) member instead. */
export interface StatsdSample {
  name: string;
  type: StatsdType;
  value: number;
  setMember: string | undefined;
  /** `true` for a gauge value with an explicit leading `+`/`-` (a relative adjustment). */
  isDelta: boolean;
  /** Sample rate (0, 1], e.g. `0.1` for "1 in 10 sent". Default 1 (unsampled). */
  sampleRate: number;
  tags: Map<string, string>;
}

export interface StatsdParseOptions {
  /** Maximum number of lines accepted from one packet. Default 10000. */
  maxLines?: number;
  /** Maximum number of tags per line. Default 128. */
  maxTags?: number;
}

const DEFAULT_MAX_LINES = 10_000;
const DEFAULT_MAX_TAGS = 128;

const TYPES: ReadonlySet<string> = new Set(['c', 'g', 'ms', 'h', 'd', 's']);

/** Parses one StatsD/DogStatsD line: `name:value|type[|@rate][|#tag1:v1,tag2]`. DogStatsD's
 * multi-value shorthand (`name:v1:v2:v3|type|...`) expands to several samples sharing the same
 * type, rate, and tags. */
export function parseStatsdLine(line: string, options: StatsdParseOptions = {}): StatsdSample[] {
  const maxTags = options.maxTags ?? DEFAULT_MAX_TAGS;
  const colon = line.indexOf(':');
  if (colon <= 0) fail('expected "<name>:<value>|<type>"');
  const name = line.slice(0, colon);

  const segments = line.slice(colon + 1).split('|');
  if (segments.length < 2) fail('expected a "|<type>" segment');
  const valuesPart = segments[0]!;
  const type = segments[1]!;
  if (!TYPES.has(type)) fail(`unknown StatsD type ${JSON.stringify(type)}`);

  let sampleRate = 1;
  const tags = new Map<string, string>();
  for (let i = 2; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('@')) {
      sampleRate = Number(seg.slice(1));
      if (!(sampleRate > 0 && sampleRate <= 1)) fail(`invalid sample rate ${JSON.stringify(seg)}`);
    } else if (seg.startsWith('#')) {
      parseTags(seg.slice(1), tags, maxTags);
    }
    // Unrecognised segments (e.g. DogStatsD "|c:<container-id>") are ignored for forward compatibility.
  }

  const rawValues = type === 's' ? [valuesPart] : valuesPart.split(':');
  return rawValues.map((raw) => parseOneValue(name, type as StatsdType, raw, sampleRate, tags));
}

function parseOneValue(
  name: string,
  type: StatsdType,
  raw: string,
  sampleRate: number,
  tags: Map<string, string>,
): StatsdSample {
  if (type === 's') {
    return { name, type, value: 0, setMember: raw, isDelta: false, sampleRate, tags };
  }
  const isDelta = type === 'g' && (raw.startsWith('+') || raw.startsWith('-'));
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`invalid ${type} value ${JSON.stringify(raw)}`);
  return { name, type, value, setMember: undefined, isDelta, sampleRate, tags };
}

function parseTags(text: string, out: Map<string, string>, maxTags: number): void {
  if (text === '') return;
  for (const part of text.split(',')) {
    if (out.size >= maxTags) throw new LimitExceededError('statsd.tags', maxTags);
    const eq = part.indexOf(':');
    if (eq === -1) out.set(part, '');
    else out.set(part.slice(0, eq), part.slice(eq + 1));
  }
}

/** Parses a whole packet (one or more `\n`-separated lines; blank lines are skipped). */
export function parseStatsdPacket(text: string, options: StatsdParseOptions = {}): StatsdSample[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const samples: StatsdSample[] = [];
  let lineCount = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed === '') continue;
    lineCount++;
    if (lineCount > maxLines) throw new LimitExceededError('statsd.lines', maxLines);
    samples.push(...parseStatsdLine(trimmed, options));
  }
  return samples;
}

export interface StatsdDecodeOptions extends StatsdParseOptions {
  /** Timestamp assigned to every decoded event. Default `Timestamp.now()`. */
  now?: Timestamp;
}

/**
 * Decodes a packet into {@link MetricEvent}s.
 *
 * - `c` (counter): `{ type: 'counter' }`, kind `incremental`, value divided by `sampleRate` (so a
 *   `@0.1`-sampled `+1` becomes `10`, correcting for the sampling).
 * - `g` (gauge): `{ type: 'gauge' }`; a signed value (`+5`, `-3`) is kind `incremental` (a
 *   relative adjustment), an unsigned one is kind `absolute`.
 * - `ms`/`h` (timer/histogram) and `d` (distribution): one-sample `{ type: 'distribution',
 *   statistic: 'histogram' }` events, kind `incremental`, with `Sample.rate = 1 / sampleRate` (so
 *   a sampled observation counts for the observations it stands in for).
 * - `s` (set): `{ type: 'set', values: {member} }`, kind `incremental`.
 */
export function decodeStatsdToMetricEvents(
  text: string,
  options: StatsdDecodeOptions = {},
): MetricEvent[] {
  const samples = parseStatsdPacket(text, options);
  const now = options.now ?? Timestamp.now();
  return samples.map((sample) => sampleToEvent(sample, now));
}

function sampleToEvent(sample: StatsdSample, now: Timestamp): MetricEvent {
  const { value, kind } = toMetricValue(sample);
  return new MetricEvent({
    name: sample.name,
    tags: sample.tags,
    kind,
    value,
    timestamp: now,
    metadata: createMetadata(),
  });
}

function toMetricValue(sample: StatsdSample): { value: MetricValue; kind: MetricKind } {
  switch (sample.type) {
    case 'c':
      return {
        value: { type: 'counter', value: sample.value / sample.sampleRate },
        kind: 'incremental',
      };
    case 'g':
      return {
        value: { type: 'gauge', value: sample.value },
        kind: sample.isDelta ? 'incremental' : 'absolute',
      };
    case 'ms':
    case 'h':
    case 'd':
      return {
        value: {
          type: 'distribution',
          statistic: 'histogram',
          samples: [{ value: sample.value, rate: 1 / sample.sampleRate }],
        },
        kind: 'incremental',
      };
    case 's':
      return {
        value: {
          type: 'set',
          values: new Set(sample.setMember !== undefined ? [sample.setMember] : []),
        },
        kind: 'incremental',
      };
  }
}

// --- encode -----------------------------------------------------------------------------------

/** Formats one StatsD line's `#tag:value,bareTag` suffix, or `''` when there are no tags. A tag
 * whose value is the empty string is written bare (round-tripping {@link parseStatsdLine}'s
 * convention for a valueless tag). */
function formatTags(tags: Map<string, string>): string {
  if (tags.size === 0) return '';
  const parts = [...tags].map(([k, v]) => (v === '' ? k : `${k}:${v}`));
  return `|#${parts.join(',')}`;
}

function formatNumber(value: number): string {
  return stringifyValue(value);
}

function encodeLine(
  name: string,
  value: string,
  type: StatsdType,
  tags: Map<string, string>,
): string {
  return `${name}:${value}|${type}${formatTags(tags)}`;
}

/**
 * Encodes one {@link MetricEvent} as one or more StatsD/DogStatsD lines (no trailing newline; join
 * with `\n` for a packet):
 *
 * - `counter`: `name:value|c`. StatsD counters are inherently incremental; an `absolute` counter
 *   encodes its raw value verbatim, which most collectors will treat as a fresh increment rather
 *   than a total — convert to `incremental` first if that matters.
 * - `gauge`: `name:value|g` when `absolute`; `name:+value|g`/`name:-value|g` (an explicit sign)
 *   when `incremental`, matching {@link parseStatsdLine}'s delta convention.
 * - `set`: one `name:member|s` line per member.
 * - `distribution`: one `name:value|d` line per sample, with `@sampleRate = 1 / Sample.rate` when
 *   the sample's rate is not 1 (the inverse of how {@link decodeStatsdToMetricEvents} builds it).
 * - `histogram` and `summary` have no StatsD representation and raise
 *   `E_STATSD_UNSUPPORTED_METRIC_TYPE`; convert to samples (e.g. via a synthetic distribution)
 *   before encoding.
 */
export function encodeMetricEventAsStatsd(event: MetricEvent): string[] {
  const name = event.series.name;
  const tags = event.series.tags;
  switch (event.value.type) {
    case 'counter':
      return [encodeLine(name, formatNumber(event.value.value), 'c', tags)];
    case 'gauge': {
      const v = event.value.value;
      const text =
        event.metricKind === 'incremental'
          ? v >= 0
            ? `+${formatNumber(v)}`
            : formatNumber(v)
          : formatNumber(v);
      return [encodeLine(name, text, 'g', tags)];
    }
    case 'set':
      return [...event.value.values].map((member) => encodeLine(name, member, 's', tags));
    case 'distribution':
      return event.value.samples.map((sample) => {
        const rateSuffix =
          sample.rate > 0 && sample.rate !== 1 ? `|@${formatNumber(1 / sample.rate)}` : '';
        return `${name}:${formatNumber(sample.value)}|d${rateSuffix}${formatTags(tags)}`;
      });
    case 'histogram':
    case 'summary':
      throw new CodecSyntaxError(
        CODEC,
        'E_STATSD_UNSUPPORTED_METRIC_TYPE',
        `StatsD has no representation for metric value type ${JSON.stringify(event.value.type)}`,
      );
  }
}

/** Encodes several events as one StatsD packet (lines joined with `\n`, with a trailing `\n`). */
export function encodeMetricEventsAsStatsdPacket(events: readonly MetricEvent[]): string {
  const lines: string[] = [];
  for (const event of events) lines.push(...encodeMetricEventAsStatsd(event));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
