import {
  cloneValue,
  kindOf,
  LogEvent,
  Timestamp,
  toHex,
  type SpanAnnotation,
  type SpanEvent,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { abortSignal } from '../runtime/signal.js';
import type { Span } from '../syntax/source.js';

/**
 * Builds the `LogEvent`-shaped view of `event` that a compiled program actually runs against (see
 * `docs/language/design.md`'s "Span events" and `span/schema.ts`'s field-by-field doc for the
 * shape). The view shares `event.metadata` by reference (never cloned — same rationale as
 * `metric/view.ts`'s `metricEventToView`: it never escapes the caller), but every other field is a
 * genuine copy, not an alias into `event` itself — `.attributes`/`.resource`/`.annotations[].
 * attributes`/`.links[].attributes` are deep-cloned (`cloneValue`) rather than shared, so a program
 * that mutates one of these maps *in place* (through a captured local variable, say) and then
 * aborts leaves the real span untouched; only a `continue` followed by {@link applyViewToSpan}
 * writes anything back into `event`.
 */
export function spanEventToView(event: SpanEvent): LogEvent {
  const fields: ValueMap = new Map();
  fields.set('trace_id', event.traceIdHex);
  fields.set('span_id', event.spanIdHex);
  fields.set('parent_span_id', event.parentSpanId === undefined ? null : toHex(event.parentSpanId));
  fields.set('trace_state', event.traceState ?? null);
  fields.set('name', event.name);
  fields.set('kind', event.spanKind);
  fields.set('start_time', event.startTime);
  fields.set('end_time', event.endTime);
  fields.set('duration', event.durationNanos);
  fields.set('status', statusToView(event.status));
  fields.set('attributes', cloneValue(event.attributes));
  fields.set('resource', cloneValue(event.resource));
  fields.set('annotations', event.annotations.map(annotationToView));
  fields.set('links', event.links.map(linkToView));
  return new LogEvent(fields, event.metadata);
}

function statusToView(status: SpanStatus): ValueMap {
  const view: ValueMap = new Map();
  view.set('code', status.code);
  view.set('message', status.message ?? null);
  return view;
}

function annotationToView(annotation: SpanAnnotation): ValueMap {
  const view: ValueMap = new Map();
  view.set('name', annotation.name);
  view.set('time', annotation.time);
  view.set('attributes', cloneValue(annotation.attributes));
  return view;
}

function linkToView(link: SpanLink): ValueMap {
  const view: ValueMap = new Map();
  view.set('trace_id', toHex(link.traceId));
  view.set('span_id', toHex(link.spanId));
  view.set('trace_state', link.traceState ?? null);
  view.set('attributes', cloneValue(link.attributes));
  return view;
}

/**
 * Converts `view`'s final fields — after a compiled program has run against the
 * {@link spanEventToView} of `event` — back into `event`, mutating it in place. `span` is used for
 * the `Span` any thrown `ScriptSignal` carries, matching `applyViewToMetric`'s convention.
 *
 * Only the writable fields are read back: `.name`, `.trace_state`, `.kind`, `.start_time`,
 * `.end_time`, `.status`, `.attributes`, `.resource`. `.trace_id`/`.span_id`/`.parent_span_id`
 * (assigned once, by the tracing system), `.duration` (derived from `.start_time`/`.end_time`,
 * recomputed from them rather than stored), and `.annotations`/`.links` (a record of what already
 * happened) are never read back — the checker already refuses to compile a program that assigns to
 * any of them (`spanReadonlyPaths`, diagnostic `E311`), and this is the second half of that
 * decision, exactly like `applyViewToMetric` never reading back `.value_type`: a caller that
 * somehow compiled without `readonlyPaths` still cannot change them through write-back.
 *
 * Every field this function *does* read back is also validated, not just type-checked (design.md's
 * "deliberately not fully sound at the type level" tradeoff, same as the metric view): `.kind` must
 * be one of `SpanEvent`'s six `SpanKind` values, `.status.code` must be `"unset"`/`"ok"`/`"error"`,
 * and every `.attributes`/`.resource` value must be a valid OTLP attribute value (recursively, for
 * a nested array/object) — a mismatch aborts the event with a clear reason instead of silently
 * producing a span whose data the rest of the pipeline (OTLP encoding, in particular) cannot
 * represent.
 */
export function applyViewToSpan(event: SpanEvent, view: LogEvent, span: Span): void {
  const fields = view.fields;

  event.name = requireString(fields.get('name'), 'name', span);

  const traceState = fields.get('trace_state');
  event.traceState =
    traceState === undefined || traceState === null
      ? undefined
      : requireString(traceState, 'trace_state', span);

  event.spanKind = requireSpanKind(fields.get('kind'), span);
  event.startTime = requireTimestamp(fields.get('start_time'), 'start_time', span);
  event.endTime = requireTimestamp(fields.get('end_time'), 'end_time', span);
  event.status = requireStatus(fields.get('status'), span);
  event.attributes = requireAttributeMap(fields.get('attributes'), 'attributes', span);
  event.resource = requireAttributeMap(fields.get('resource'), 'resource', span);
}

const SPAN_KINDS: ReadonlySet<string> = new Set([
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
]);

function requireSpanKind(value: Value | undefined, span: Span): SpanKind {
  if (typeof value === 'string' && SPAN_KINDS.has(value)) return value as SpanKind;
  throw abortSignal(
    `span '.kind' must be one of ${[...SPAN_KINDS].map((k) => `"${k}"`).join(', ')}, found ` +
      describeOptional(value),
    span,
  );
}

const SPAN_STATUS_CODES: ReadonlySet<string> = new Set(['unset', 'ok', 'error']);

function requireStatus(value: Value | undefined, span: Span): SpanStatus {
  const obj = requireObject(value, '.status', span);
  const code = obj.get('code');
  if (typeof code !== 'string' || !SPAN_STATUS_CODES.has(code)) {
    throw abortSignal(
      `span '.status.code' must be "unset", "ok", or "error", found ${describeOptional(code)}`,
      span,
    );
  }
  const status: SpanStatus = { code: code as SpanStatus['code'] };
  const message = obj.get('message');
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') {
      throw abortSignal(
        `span '.status.message' must be a string or null, found ${kindOf(message)}`,
        span,
      );
    }
    status.message = message;
  }
  return status;
}

function requireAttributeMap(value: Value | undefined, field: string, span: Span): ValueMap {
  const obj = requireObject(value, `.${field}`, span);
  for (const [key, attrValue] of obj) requireAttributeValue(attrValue, `.${field}.${key}`, span);
  return obj;
}

/**
 * Recursively checks that `value` is a valid OTLP attribute value: every `@ferrule/core` `Value`
 * kind round-trips through `AnyValue` (see `packages/codecs/src/otlp/common.ts`'s
 * `writeAnyValueBody`, which handles every one of them, a `Timestamp` via its RFC 3339 string
 * representation), so this is mostly defense-in-depth against something that slipped past
 * `kindOf` entirely (which throws for a value that is not a `Value` at all) — reachable only
 * through the same kind of open `any`-rest escape hatch design.md's metric-events section already
 * documents for `.tags`, since `.attributes`/`.resource` are typed `object { ..any }`.
 */
function requireAttributeValue(value: Value, path: string, span: Span): void {
  const kind = (() => {
    try {
      return kindOf(value);
    } catch {
      throw abortSignal(`'${path}' is not a valid OTLP attribute value`, span);
    }
  })();
  if (kind === 'array') {
    (value as Value[]).forEach((item, i) => requireAttributeValue(item, `${path}[${i}]`, span));
  } else if (kind === 'object') {
    for (const [key, nested] of value as ValueMap) {
      requireAttributeValue(nested, `${path}.${key}`, span);
    }
  }
}

function requireString(value: Value | undefined, field: string, span: Span): string {
  if (typeof value !== 'string') {
    throw abortSignal(`span '.${field}' must be a string, found ${describeOptional(value)}`, span);
  }
  return value;
}

function requireTimestamp(value: Value | undefined, field: string, span: Span): Timestamp {
  if (!(value instanceof Timestamp)) {
    throw abortSignal(
      `span '.${field}' must be a timestamp, found ${describeOptional(value)}`,
      span,
    );
  }
  return value;
}

function requireObject(value: Value | undefined, field: string, span: Span): ValueMap {
  if (!(value instanceof Map)) {
    throw abortSignal(`span '${field}' must be an object, found ${describeOptional(value)}`, span);
  }
  return value;
}

function describeOptional(value: Value | undefined): string {
  return value === undefined ? 'nothing (deleted)' : kindOf(value);
}
