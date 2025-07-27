import {
  createMetadata,
  LimitExceededError,
  MetricEvent,
  Timestamp,
  type Bucket,
  type MetricValue,
  type Quantile,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyValue } from '../value_text.js';

const CODEC = 'prometheus_text';

function fail(message: string, offset?: number): never {
  throw new CodecSyntaxError(CODEC, 'E_PROMETHEUS_SYNTAX', message, offset);
}

export type PrometheusMetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

/** One `name{labels} value [timestamp]` line. */
export interface PrometheusSample {
  name: string;
  labels: Map<string, string>;
  value: number;
  timestampMs: number | undefined;
}

export interface PrometheusDocument {
  samples: PrometheusSample[];
  help: Map<string, string>;
  types: Map<string, PrometheusMetricType>;
}

export interface PrometheusParseOptions {
  /** Maximum number of samples accepted. Default 100000. */
  maxSamples?: number;
  /** Maximum number of labels per sample. Default 128. */
  maxLabels?: number;
}

const DEFAULT_MAX_SAMPLES = 100_000;
const DEFAULT_MAX_LABELS = 128;

// Sticky ("y") regexes already anchor matching at `lastIndex`; a leading "^" would additionally
// require position 0, breaking matches anywhere else in the line (e.g. label names after "{").
const METRIC_NAME = /[a-zA-Z_:][a-zA-Z0-9_:]*/y;
const LABEL_NAME = /[a-zA-Z_][a-zA-Z0-9_]*/y;

/**
 * Parses the Prometheus text exposition format (the `text/plain; version=0.0.4` format scraped
 * from `/metrics` endpoints): `# HELP`/`# TYPE` metadata comments, `name{label="value",...} value
 * [timestamp]` samples, label-value escaping (`\\`, `\"`, `\n`), and `NaN`/`+Inf`/`-Inf` values.
 */
export function parsePrometheusText(
  text: string,
  options: PrometheusParseOptions = {},
): PrometheusDocument {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const maxLabels = options.maxLabels ?? DEFAULT_MAX_LABELS;
  const help = new Map<string, string>();
  const types = new Map<string, PrometheusMetricType>();
  const samples: PrometheusSample[] = [];

  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo]!;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    if (line.startsWith('#')) {
      parseComment(line, help, types);
      continue;
    }
    if (samples.length >= maxSamples) {
      throw new LimitExceededError('prometheus.samples', maxSamples);
    }
    samples.push(parseSampleLine(line, maxLabels));
  }
  return { samples, help, types };
}

function parseComment(
  line: string,
  help: Map<string, string>,
  types: Map<string, PrometheusMetricType>,
): void {
  const m = /^#\s*(HELP|TYPE)\s+(\S+)\s+(.*)$/.exec(line);
  if (m === null) return; // plain comment
  const [, kind, name, rest] = m as unknown as [string, 'HELP' | 'TYPE', string, string];
  if (kind === 'HELP') {
    help.set(name, unescapeHelp(rest));
  } else {
    const type = rest.trim();
    if (isMetricType(type)) types.set(name, type);
  }
}

function isMetricType(s: string): s is PrometheusMetricType {
  return (
    s === 'counter' || s === 'gauge' || s === 'histogram' || s === 'summary' || s === 'untyped'
  );
}

function unescapeHelp(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '\\' || text[i + 1] === 'n')) {
      out += text[i + 1] === 'n' ? '\n' : '\\';
      i++;
    } else {
      out += text[i];
    }
  }
  return out;
}

function parseSampleLine(line: string, maxLabels: number): PrometheusSample {
  let pos = 0;
  METRIC_NAME.lastIndex = 0;
  const nameMatch = METRIC_NAME.exec(line);
  if (nameMatch === null) fail('expected a metric name', pos);
  const name = nameMatch[0];
  pos = nameMatch[0].length;

  const labels = new Map<string, string>();
  if (line[pos] === '{') {
    pos++;
    pos = parseLabels(line, pos, labels, maxLabels);
    if (line[pos] !== '}') fail('expected "}" to close the label set', pos);
    pos++;
  }
  while (line[pos] === ' ') pos++;

  const rest = line.slice(pos).trim();
  const tokens = rest.split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') fail('expected a sample value', pos);
  const value = parseSampleValue(tokens[0]!);
  const timestampMs = tokens.length > 1 ? Number(tokens[1]) : undefined;
  if (timestampMs !== undefined && !Number.isFinite(timestampMs)) {
    fail('invalid sample timestamp', pos);
  }

  return { name, labels, value, timestampMs };
}

function parseLabels(
  line: string,
  start: number,
  out: Map<string, string>,
  maxLabels: number,
): number {
  let pos = start;
  while (line[pos] === ' ') pos++;
  if (line[pos] === '}') return pos;
  for (;;) {
    if (out.size >= maxLabels) throw new LimitExceededError('prometheus.labels', maxLabels);
    LABEL_NAME.lastIndex = pos;
    const m = LABEL_NAME.exec(line);
    if (m === null) fail('expected a label name', pos);
    const labelName = m[0];
    pos += m[0].length;
    if (line[pos] !== '=') fail('expected "=" after label name', pos);
    pos++;
    if (line[pos] !== '"') fail('expected a quoted label value', pos);
    const { value, next } = parseLabelValue(line, pos);
    out.set(labelName, value);
    pos = next;
    while (line[pos] === ' ') pos++;
    if (line[pos] === ',') {
      pos++;
      while (line[pos] === ' ') pos++;
      if (line[pos] === '}') return pos;
      continue;
    }
    return pos;
  }
}

function parseLabelValue(text: string, start: number): { value: string; next: number } {
  let pos = start + 1;
  let value = '';
  while (pos < text.length && text[pos] !== '"') {
    if (text[pos] === '\\') {
      const e = text[pos + 1];
      if (e === '"' || e === '\\') {
        value += e;
        pos += 2;
        continue;
      }
      if (e === 'n') {
        value += '\n';
        pos += 2;
        continue;
      }
      fail(`invalid escape "\\${e ?? ''}" in label value`, pos);
    }
    value += text[pos];
    pos++;
  }
  if (text[pos] !== '"') fail('unterminated label value', pos);
  return { value, next: pos + 1 };
}

function parseSampleValue(token: string): number {
  if (token === 'NaN') return NaN;
  if (token === '+Inf' || token === 'Inf') return Infinity;
  if (token === '-Inf') return -Infinity;
  const n = Number(token);
  if (Number.isNaN(n) && token !== 'NaN') fail(`invalid sample value ${JSON.stringify(token)}`);
  return n;
}

// --- Document -> MetricEvent ------------------------------------------------------------------

export interface PrometheusDecodeOptions extends PrometheusParseOptions {
  /** Timestamp used for samples with no inline timestamp. Default `Timestamp.now()`. */
  now?: Timestamp;
}

/** Converts a parsed document into absolute {@link MetricEvent}s: `histogram`/`summary` families
 * (matched by base name, with `le`/`quantile` stripped from the grouping label set) are combined
 * into one event per label combination; everything else maps one sample to one event. */
export function decodePrometheusText(
  text: string,
  options: PrometheusDecodeOptions = {},
): MetricEvent[] {
  const doc = parsePrometheusText(text, options);
  const now = options.now ?? Timestamp.now();
  const events: MetricEvent[] = [];

  const histogramGroups = new Map<
    string,
    {
      labels: Map<string, string>;
      buckets: Map<number, number>;
      sum: number;
      count: number;
      timestampMs: number | undefined;
    }
  >();
  const summaryGroups = new Map<
    string,
    {
      labels: Map<string, string>;
      quantiles: Map<number, number>;
      sum: number;
      count: number;
      timestampMs: number | undefined;
    }
  >();

  for (const sample of doc.samples) {
    const baseType = baseMetricType(sample.name, doc.types);
    if (baseType === 'histogram') {
      addToHistogramGroup(histogramGroups, sample);
      continue;
    }
    if (baseType === 'summary') {
      addToSummaryGroup(summaryGroups, sample);
      continue;
    }
    const type = doc.types.get(sample.name) ?? 'untyped';
    const value: MetricValue =
      type === 'counter'
        ? { type: 'counter', value: sample.value }
        : { type: 'gauge', value: sample.value };
    events.push(
      buildEvent(
        sample.name,
        sample.labels,
        value,
        sample.timestampMs !== undefined ? Timestamp.fromMillis(sample.timestampMs) : now,
      ),
    );
  }

  for (const [key, group] of histogramGroups) {
    const name = key.split('\u0000')[0]!;
    const bounds = [...group.buckets.keys()].filter((b) => b !== Infinity).sort((a, b) => a - b);
    let cumulativePrev = 0;
    const buckets: Bucket[] = bounds.map((upperLimit) => {
      const cumulative = group.buckets.get(upperLimit) ?? 0;
      const count = cumulative - cumulativePrev;
      cumulativePrev = cumulative;
      return { upperLimit, count };
    });
    const total = group.count > 0 ? group.count : (group.buckets.get(Infinity) ?? cumulativePrev);
    const value: MetricValue = { type: 'histogram', buckets, count: total, sum: group.sum };
    events.push(
      buildEvent(
        name,
        group.labels,
        value,
        group.timestampMs !== undefined ? Timestamp.fromMillis(group.timestampMs) : now,
      ),
    );
  }

  for (const [key, group] of summaryGroups) {
    const name = key.split('\u0000')[0]!;
    const quantiles: Quantile[] = [...group.quantiles.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([quantile, value]) => ({ quantile, value }));
    const value: MetricValue = { type: 'summary', quantiles, count: group.count, sum: group.sum };
    events.push(
      buildEvent(
        name,
        group.labels,
        value,
        group.timestampMs !== undefined ? Timestamp.fromMillis(group.timestampMs) : now,
      ),
    );
  }

  return events;
}

function baseMetricType(
  name: string,
  types: Map<string, PrometheusMetricType>,
): PrometheusMetricType | undefined {
  if (types.get(name) === 'histogram' || types.get(name) === 'summary') return types.get(name);
  for (const suffix of ['_bucket', '_sum', '_count']) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      const t = types.get(base);
      if (t === 'histogram' || t === 'summary') return t;
    }
  }
  return undefined;
}

function groupKey(name: string, labels: Map<string, string>, exclude: string): string {
  const parts = [...labels.entries()]
    .filter(([k]) => k !== exclude)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${name}\u0000${parts.map(([k, v]) => `${k}=${v}`).join('\u0001')}`;
}

function stripSuffix(name: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}

function addToHistogramGroup(
  groups: Map<
    string,
    {
      labels: Map<string, string>;
      buckets: Map<number, number>;
      sum: number;
      count: number;
      timestampMs: number | undefined;
    }
  >,
  sample: PrometheusSample,
): void {
  const base = stripSuffix(sample.name, ['_bucket', '_sum', '_count']);
  const key = groupKey(base, sample.labels, 'le');
  let group = groups.get(key);
  if (group === undefined) {
    group = {
      labels: withoutLabel(sample.labels, 'le'),
      buckets: new Map(),
      sum: 0,
      count: 0,
      timestampMs: undefined,
    };
    groups.set(key, group);
  }
  if (group.timestampMs === undefined) group.timestampMs = sample.timestampMs;
  if (sample.name.endsWith('_bucket')) {
    const le = sample.labels.get('le');
    const bound = le === '+Inf' ? Infinity : Number(le);
    group.buckets.set(bound, sample.value);
  } else if (sample.name.endsWith('_sum')) {
    group.sum = sample.value;
  } else if (sample.name.endsWith('_count')) {
    group.count = sample.value;
  }
}

function addToSummaryGroup(
  groups: Map<
    string,
    {
      labels: Map<string, string>;
      quantiles: Map<number, number>;
      sum: number;
      count: number;
      timestampMs: number | undefined;
    }
  >,
  sample: PrometheusSample,
): void {
  const base = stripSuffix(sample.name, ['_sum', '_count']);
  const key = groupKey(base, sample.labels, 'quantile');
  let group = groups.get(key);
  if (group === undefined) {
    group = {
      labels: withoutLabel(sample.labels, 'quantile'),
      quantiles: new Map(),
      sum: 0,
      count: 0,
      timestampMs: undefined,
    };
    groups.set(key, group);
  }
  if (group.timestampMs === undefined) group.timestampMs = sample.timestampMs;
  if (sample.name.endsWith('_sum')) {
    group.sum = sample.value;
  } else if (sample.name.endsWith('_count')) {
    group.count = sample.value;
  } else {
    const q = sample.labels.get('quantile');
    if (q !== undefined) group.quantiles.set(Number(q), sample.value);
  }
}

function withoutLabel(labels: Map<string, string>, name: string): Map<string, string> {
  const out = new Map(labels);
  out.delete(name);
  return out;
}

function buildEvent(
  name: string,
  tags: Map<string, string>,
  value: MetricValue,
  timestamp: Timestamp,
): MetricEvent {
  return new MetricEvent({
    name,
    tags,
    kind: 'absolute',
    value,
    timestamp,
    metadata: createMetadata(),
  });
}

// --- MetricEvent -> Prometheus text -------------------------------------------------------------

export interface PrometheusEncodeOptions {
  /** Whether to emit inline sample timestamps (from `MetricEvent.timestamp`). Default `false`
   * (most scrape-based consumers expect the scraper to assign timestamps). */
  includeTimestamps?: boolean;
}

/** Encodes `events` as Prometheus text exposition format. Non-cumulative core histogram buckets
 * are converted to Prometheus's cumulative `le` buckets (each bucket's count becomes the running
 * total up to and including it), with a synthesised `+Inf` bucket equal to the total count. */
export function encodePrometheusText(
  events: readonly MetricEvent[],
  options: PrometheusEncodeOptions = {},
): string {
  const lines: string[] = [];
  const seenType = new Set<string>();
  for (const event of events) {
    const metricName = sanitizeMetricName(event.series.name);
    if (!seenType.has(metricName)) {
      seenType.add(metricName);
      lines.push(`# TYPE ${metricName} ${prometheusType(event.value.type)}`);
    }
    lines.push(...encodeSample(event, metricName, options));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function prometheusType(type: MetricValue['type']): PrometheusMetricType {
  switch (type) {
    case 'counter':
      return 'counter';
    case 'histogram':
      return 'histogram';
    case 'summary':
      return 'summary';
    default:
      return 'gauge';
  }
}

function encodeSample(
  event: MetricEvent,
  name: string,
  options: PrometheusEncodeOptions,
): string[] {
  const suffix =
    options.includeTimestamps && event.timestamp !== undefined
      ? ` ${event.timestamp.toMillis()}`
      : '';
  const labelText = formatLabels(event.series.tags);
  switch (event.value.type) {
    case 'counter':
    case 'gauge':
      return [`${name}${labelText} ${formatValue(event.value.value)}${suffix}`];
    case 'histogram':
      return encodeHistogramSample(event.value, name, event.series.tags, suffix);
    case 'summary':
      return encodeSummarySample(event.value, name, event.series.tags, suffix);
    case 'set':
      return [`${name}${labelText} ${formatValue(event.value.values.size)}${suffix}`];
    case 'distribution':
      return event.value.samples.map(
        (s, i) =>
          `${name}${formatLabels(withLabel(event.series.tags, 'sample', String(i)))} ${formatValue(s.value)}${suffix}`,
      );
  }
}

function encodeHistogramSample(
  value: Extract<MetricValue, { type: 'histogram' }>,
  name: string,
  tags: Map<string, string>,
  suffix: string,
): string[] {
  const lines: string[] = [];
  let cumulative = 0;
  for (const bucket of value.buckets) {
    cumulative += bucket.count;
    lines.push(
      `${name}_bucket${formatLabels(withLabel(tags, 'le', formatValue(bucket.upperLimit)))} ${formatValue(cumulative)}${suffix}`,
    );
  }
  lines.push(
    `${name}_bucket${formatLabels(withLabel(tags, 'le', '+Inf'))} ${formatValue(value.count)}${suffix}`,
  );
  lines.push(`${name}_sum${formatLabels(tags)} ${formatValue(value.sum)}${suffix}`);
  lines.push(`${name}_count${formatLabels(tags)} ${formatValue(value.count)}${suffix}`);
  return lines;
}

function encodeSummarySample(
  value: Extract<MetricValue, { type: 'summary' }>,
  name: string,
  tags: Map<string, string>,
  suffix: string,
): string[] {
  const lines: string[] = [];
  for (const q of value.quantiles) {
    lines.push(
      `${name}${formatLabels(withLabel(tags, 'quantile', formatValue(q.quantile)))} ${formatValue(q.value)}${suffix}`,
    );
  }
  lines.push(`${name}_sum${formatLabels(tags)} ${formatValue(value.sum)}${suffix}`);
  lines.push(`${name}_count${formatLabels(tags)} ${formatValue(value.count)}${suffix}`);
  return lines;
}

function withLabel(tags: Map<string, string>, name: string, value: string): Map<string, string> {
  const out = new Map(tags);
  out.set(name, value);
  return out;
}

function formatLabels(tags: Map<string, string>): string {
  if (tags.size === 0) return '';
  const parts = [...tags.entries()].map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return stringifyValue(value);
}

const METRIC_NAME_SANITIZE = /[^a-zA-Z0-9_:]/g;

function sanitizeMetricName(name: string): string {
  const sanitized = name.replace(METRIC_NAME_SANITIZE, '_');
  return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
