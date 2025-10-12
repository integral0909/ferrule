import {
  getPath,
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  type Event,
  type Path,
  type Value,
} from '@ferrule/core';

/**
 * A best-effort field accessor across all three event kinds, for operators (`sample`) that are
 * documented to work on any event kind but only offer real field addressing for logs. Metrics
 * expose `name`, `namespace`, and `tags.<key>`; spans expose `name`, `status`, and
 * `attributes.<path>`; anything else returns `undefined` rather than throwing.
 */
export function getEventField(event: Event, path: Path): Value | undefined {
  if (path.length === 0) return undefined;
  if (isLogEvent(event)) return event.get(path);
  if (isMetricEvent(event)) {
    const [head, ...rest] = path;
    if (head === 'name' && rest.length === 0) return event.series.name;
    if (head === 'namespace' && rest.length === 0) return event.series.namespace;
    if (head === 'tags' && rest.length === 1 && typeof rest[0] === 'string') {
      return event.series.tags.get(rest[0]);
    }
    return undefined;
  }
  if (isSpanEvent(event)) {
    const [head, ...rest] = path;
    if (head === 'name' && rest.length === 0) return event.name;
    if (head === 'status' && rest.length === 0) return event.status.code;
    if (head === 'attributes') return getPath(event.attributes, rest);
    if (head === 'resource') return getPath(event.resource, rest);
    return undefined;
  }
  return undefined;
}
