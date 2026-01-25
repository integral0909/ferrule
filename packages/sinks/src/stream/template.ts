import {
  daysFromCivil,
  formatValue,
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  parsePath,
  type Event,
  type Path,
  type Timestamp,
  type Value,
} from '@ferrule/core';
import { stringifyValue } from '@ferrule/codecs';

/**
 * A small template engine shared by every sink that needs to turn a per-event pattern into a
 * concrete string: file paths, Kafka topic/key/header templates, syslog app-name mapping. Two
 * kinds of placeholder are supported, matching what Vector-style pipelines expect:
 *
 * - `{{ field.path }}` — an event field reference, resolved with {@link getEventField} and
 *   rendered with {@link stringifyValue} (missing fields render as an empty string).
 * - `%Y`, `%m`, `%d`, `%H`, `%M`, `%S`, `%j`, `%%` — strftime-style specifiers, resolved against a
 *   caller-supplied `now` timestamp (usually the clock's current time, not a per-event one, since
 *   these typically drive file rotation).
 *
 * Everything else is a literal.
 */
export type TemplateSegment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'field'; readonly path: Path; readonly raw: string }
  | { readonly kind: 'time'; readonly spec: string };

export interface CompiledTemplate {
  readonly source: string;
  readonly segments: readonly TemplateSegment[];
  readonly hasFieldRefs: boolean;
  readonly hasTimeRefs: boolean;
  /** True if the template is just one literal segment (a constant string). */
  readonly isConstant: boolean;
}

const STRFTIME_SPECS = new Set(['Y', 'y', 'm', 'd', 'H', 'M', 'S', 'j', '%']);

/** Compiles a template pattern once, so it can be rendered cheaply per event. */
export function compileTemplate(pattern: string): CompiledTemplate {
  const segments: TemplateSegment[] = [];
  let literal = '';
  let hasFieldRefs = false;
  let hasTimeRefs = false;
  const flushLiteral = (): void => {
    if (literal !== '') {
      segments.push({ kind: 'literal', text: literal });
      literal = '';
    }
  };

  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === '{' && pattern[i + 1] === '{') {
      const end = pattern.indexOf('}}', i + 2);
      if (end === -1) {
        literal += c;
        i++;
        continue;
      }
      const raw = pattern.slice(i + 2, end).trim();
      flushLiteral();
      segments.push({ kind: 'field', path: parsePath(raw), raw });
      hasFieldRefs = true;
      i = end + 2;
      continue;
    }
    if (c === '%' && i + 1 < n && STRFTIME_SPECS.has(pattern[i + 1]!)) {
      flushLiteral();
      const spec = pattern[i + 1]!;
      segments.push({ kind: 'time', spec });
      hasTimeRefs = hasTimeRefs || spec !== '%';
      i += 2;
      continue;
    }
    literal += c;
    i++;
  }
  flushLiteral();
  return {
    source: pattern,
    segments,
    hasFieldRefs,
    hasTimeRefs,
    isConstant: segments.length <= 1 && !hasFieldRefs && !hasTimeRefs,
  };
}

/** Reads a template field reference from any event kind, on a best-effort basis: `LogEvent`
 * fields are read directly; a `MetricEvent` exposes `name` and `tags.<key>`; a `SpanEvent`
 * exposes `name` and `attributes.<key>`. Unsupported paths resolve to `undefined`. */
export function getEventField(event: Event, path: Path): Value | undefined {
  if (isLogEvent(event)) return event.get(path);
  if (path.length === 0) return undefined;
  if (isMetricEvent(event)) {
    if (path.length === 1 && path[0] === 'name') return event.name;
    if (path.length === 2 && path[0] === 'tags' && typeof path[1] === 'string') {
      return event.tags.get(path[1]);
    }
    return undefined;
  }
  if (isSpanEvent(event)) {
    if (path.length === 1 && path[0] === 'name') return event.name;
    if (path.length === 2 && path[0] === 'attributes' && typeof path[1] === 'string') {
      return event.attributes.get(path[1]);
    }
    return undefined;
  }
  return undefined;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function renderTimeSpec(spec: string, civil: ReturnType<Timestamp['toCivil']>): string {
  switch (spec) {
    case 'Y':
      return String(civil.year).padStart(4, '0');
    case 'y':
      return pad2(civil.year % 100);
    case 'm':
      return pad2(civil.month);
    case 'd':
      return pad2(civil.day);
    case 'H':
      return pad2(civil.hour);
    case 'M':
      return pad2(civil.minute);
    case 'S':
      return pad2(civil.second);
    case 'j': {
      const dayOfYear =
        daysFromCivil(civil.year, civil.month, civil.day) - daysFromCivil(civil.year, 1, 1) + 1;
      return String(dayOfYear).padStart(3, '0');
    }
    case '%':
      return '%';
    default:
      return '';
  }
}

/** Renders a compiled template against one event and a reference time. */
export function renderTemplate(compiled: CompiledTemplate, event: Event, now: Timestamp): string {
  if (compiled.segments.length === 0) return '';
  const civil = compiled.hasTimeRefs ? now.toCivil() : undefined;
  let out = '';
  for (const segment of compiled.segments) {
    switch (segment.kind) {
      case 'literal':
        out += segment.text;
        break;
      case 'field': {
        const value = getEventField(event, segment.path);
        out += value === undefined ? '' : stringifyValue(value);
        break;
      }
      case 'time':
        if (segment.spec === '%') out += '%';
        else out += civil === undefined ? '' : renderTimeSpec(segment.spec, civil);
        break;
    }
  }
  return out;
}

/** Renders a compiled template with no event in scope (time-only templates). */
export function renderTemplateTimeOnly(compiled: CompiledTemplate, now: Timestamp): string {
  if (compiled.hasFieldRefs) {
    throw new RangeError(
      `template ${JSON.stringify(compiled.source)} references event fields but no event is available here`,
    );
  }
  const civil = now.toCivil();
  let out = '';
  for (const segment of compiled.segments) {
    if (segment.kind === 'literal') out += segment.text;
    else if (segment.kind === 'time') out += renderTimeSpec(segment.spec, civil);
  }
  return out;
}

/** Renders a value for diagnostics (e.g. a rejected event's key). */
export function describeValue(value: Value | undefined): string {
  return value === undefined ? '<missing>' : formatValue(value, 200);
}
