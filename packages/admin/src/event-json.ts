import {
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  toHex,
  type Event,
  type MetricValue,
  type SpanAnnotation,
  type SpanLink,
  type SpanStatus,
  type Value,
  type ValueMap,
} from '@ferrule/core';

/**
 * Converts a tapped {@link Event} into a {@link ValueMap} suitable for `@ferrule/core`'s lossless
 * JSON encoder. This is the wire shape of one line of `/tap` output. It is a debugging view, not
 * a stable wire format: field names and nesting may change between releases.
 *
 * `Timestamp` values and log fields (already a `ValueMap`) pass straight through, since both are
 * valid `Value`s the JSON encoder understands natively; everything else (metric values, span
 * IDs, statuses) is reshaped into one here.
 */
export function eventToValue(event: Event): ValueMap {
  const out: ValueMap = new Map<string, Value>();
  out.set('kind', event.kind);
  out.set('metadata', metadataValue(event));
  if (isLogEvent(event)) {
    out.set('fields', event.fields);
    return out;
  }
  if (isMetricEvent(event)) {
    out.set('name', event.series.name);
    if (event.series.namespace !== undefined) out.set('namespace', event.series.namespace);
    out.set('tags', stringMapValue(event.series.tags));
    out.set('metricKind', event.metricKind);
    out.set('value', metricValueValue(event.value));
    if (event.timestamp !== undefined) out.set('timestamp', event.timestamp);
    if (event.intervalMs !== undefined) out.set('intervalMs', event.intervalMs);
    return out;
  }
  if (isSpanEvent(event)) {
    out.set('traceId', event.traceIdHex);
    out.set('spanId', event.spanIdHex);
    if (event.parentSpanId !== undefined) out.set('parentSpanId', toHex(event.parentSpanId));
    if (event.traceState !== undefined) out.set('traceState', event.traceState);
    out.set('name', event.name);
    out.set('spanKind', event.spanKind);
    out.set('startTime', event.startTime);
    out.set('endTime', event.endTime);
    out.set('status', spanStatusValue(event.status));
    out.set('attributes', event.attributes);
    out.set('annotations', event.annotations.map(annotationValue));
    out.set('links', event.links.map(linkValue));
    out.set('resource', event.resource);
    if (event.scope !== undefined) {
      const scope: ValueMap = new Map<string, Value>([['name', event.scope.name]]);
      if (event.scope.version !== undefined) scope.set('version', event.scope.version);
      scope.set('attributes', event.scope.attributes);
      out.set('scope', scope);
    }
    return out;
  }
  return out;
}

function metadataValue(event: Event): ValueMap {
  const metadata: ValueMap = new Map<string, Value>();
  if (event.metadata.sourceId !== undefined) metadata.set('sourceId', event.metadata.sourceId);
  if (event.metadata.sourceType !== undefined) {
    metadata.set('sourceType', event.metadata.sourceType);
  }
  metadata.set('receivedAt', event.metadata.receivedAt);
  return metadata;
}

function stringMapValue(map: ReadonlyMap<string, string>): ValueMap {
  const out: ValueMap = new Map<string, Value>();
  for (const [key, value] of map) out.set(key, value);
  return out;
}

function metricValueValue(value: MetricValue): ValueMap {
  const out: ValueMap = new Map<string, Value>();
  out.set('type', value.type);
  switch (value.type) {
    case 'counter':
    case 'gauge':
      out.set('value', value.value);
      break;
    case 'set':
      out.set('values', [...value.values]);
      break;
    case 'distribution':
      out.set('statistic', value.statistic);
      out.set(
        'samples',
        value.samples.map((s) => {
          const sample: ValueMap = new Map<string, Value>();
          sample.set('value', s.value);
          sample.set('rate', s.rate);
          return sample;
        }),
      );
      break;
    case 'histogram':
      out.set(
        'buckets',
        value.buckets.map((b) => {
          const bucket: ValueMap = new Map<string, Value>();
          bucket.set('upperLimit', b.upperLimit);
          bucket.set('count', b.count);
          return bucket;
        }),
      );
      out.set('count', value.count);
      out.set('sum', value.sum);
      break;
    case 'summary':
      out.set(
        'quantiles',
        value.quantiles.map((q) => {
          const quantile: ValueMap = new Map<string, Value>();
          quantile.set('quantile', q.quantile);
          quantile.set('value', q.value);
          return quantile;
        }),
      );
      out.set('count', value.count);
      out.set('sum', value.sum);
      break;
  }
  return out;
}

function spanStatusValue(status: SpanStatus): ValueMap {
  const out: ValueMap = new Map<string, Value>([['code', status.code]]);
  if (status.message !== undefined) out.set('message', status.message);
  return out;
}

function annotationValue(annotation: SpanAnnotation): ValueMap {
  const out: ValueMap = new Map<string, Value>();
  out.set('name', annotation.name);
  out.set('time', annotation.time);
  out.set('attributes', annotation.attributes);
  return out;
}

function linkValue(link: SpanLink): ValueMap {
  const out: ValueMap = new Map<string, Value>();
  out.set('traceId', toHex(link.traceId));
  out.set('spanId', toHex(link.spanId));
  if (link.traceState !== undefined) out.set('traceState', link.traceState);
  out.set('attributes', link.attributes);
  return out;
}
