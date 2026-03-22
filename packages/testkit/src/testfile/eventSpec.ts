import { FerruleError, type Event } from '@ferrule/core';
import { isPlainObject } from '@ferrule/schema';
import * as events from '../events.js';

/**
 * Converts one raw YAML/JSON `inputs` item into an `Event` to inject at a source. A plain string
 * becomes a log event's `message` (the closest practical approximation of "decoded by the
 * source's codec" without `@ferrule/testkit` depending on `@ferrule/codecs` or knowing which
 * codec a given source type actually uses — a documented simplification, see the package
 * README). A plain object is a log event's fields, unless it carries `event_kind: metric` or
 * `event_kind: span`, in which case it is interpreted structurally against `../events.js`'s
 * builders.
 */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

function tagsOf(obj: Record<string, unknown>): Record<string, string> | undefined {
  const v = obj['tags'];
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return out;
}

function metricEventFromSpec(obj: Record<string, unknown>): Event {
  const name = str(obj, 'name');
  if (name === undefined) {
    throw new FerruleError('E_TESTKIT_INPUT_SPEC', 'a metric input needs a `name`');
  }
  const tags = tagsOf(obj);
  const options: { -readonly [K in keyof events.MetricOptions]?: events.MetricOptions[K] } = {};
  if (tags !== undefined) options.tags = tags;
  const namespace = str(obj, 'namespace');
  if (namespace !== undefined) options.namespace = namespace;

  const value = obj['value'];
  const valueObj = isPlainObject(value) ? value : {};
  const type = str(valueObj, 'type') ?? 'counter';
  switch (type) {
    case 'gauge':
      return events.gauge(name, num(valueObj, 'value') ?? 0, options);
    case 'set': {
      const values = valueObj['values'];
      return events.metricSet(
        name,
        Array.isArray(values) ? values.map((v) => String(v)) : [],
        options,
      );
    }
    case 'counter':
    default:
      return events.counter(name, num(valueObj, 'value') ?? 0, options);
  }
}

function spanEventFromSpec(obj: Record<string, unknown>): Event {
  const name = str(obj, 'name') ?? 'span';
  const options: { -readonly [K in keyof events.SpanOptions]?: events.SpanOptions[K] } = {};
  const traceId = str(obj, 'trace_id');
  if (traceId !== undefined) options.traceId = traceId;
  const spanId = str(obj, 'span_id');
  if (spanId !== undefined) options.spanId = spanId;
  const parentSpanId = str(obj, 'parent_span_id');
  if (parentSpanId !== undefined) options.parentSpanId = parentSpanId;
  const durationMs = num(obj, 'duration_ms');
  if (durationMs !== undefined) options.durationNanos = BigInt(Math.round(durationMs * 1_000_000));
  const status = obj['status'];
  if (typeof status === 'string') options.status = { code: status as 'unset' | 'ok' | 'error' };
  const attributes = obj['attributes'];
  if (isPlainObject(attributes)) options.attributes = attributes;
  return events.span(name, options);
}

/** Converts one raw `inputs` item into an `Event`. */
export function eventFromInputSpec(raw: unknown): Event {
  if (typeof raw === 'string') return events.log({ message: raw });
  if (!isPlainObject(raw)) {
    throw new FerruleError(
      'E_TESTKIT_INPUT_SPEC',
      `an input item must be a string or an object, got ${typeof raw}`,
    );
  }
  const kind = raw['event_kind'];
  if (kind === 'metric') return metricEventFromSpec(raw);
  if (kind === 'span') return spanEventFromSpec(raw);
  if (kind !== undefined && kind !== 'log') {
    throw new FerruleError('E_TESTKIT_INPUT_SPEC', `unknown event_kind ${JSON.stringify(kind)}`);
  }
  const { event_kind: _drop, ...fields } = raw;
  return events.log(fields);
}
