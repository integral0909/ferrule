import {
  anyType,
  arrayType,
  intType,
  nullType,
  objectType,
  stringType,
  timestampType,
  unionType,
  type Type,
} from '../types/types.js';

/**
 * How a `SpanEvent` (`@ferrule/core`) appears to a Ferrule Script program — see
 * `docs/language/design.md`'s "Span events" section for the full writeup; this module builds the
 * `Type` the checker types `.field` paths from (`check(program, { inputSchema: spanEventSchema(),
 * validateWrites: true, readonlyPaths: spanReadonlyPaths() })`), and `span/view.ts` builds/applies
 * the matching runtime value, the same two-module split `metric/schema.ts`/`metric/view.ts` use.
 *
 * Like the metric view, this is **flat**: every field the view exposes is one top-level name on a
 * `LogEvent`-shaped object, not a nested structure mirroring `SpanEvent`'s own TypeScript shape —
 * so `.status`, for instance, is a small object field (`{ code, message }`), not reached through a
 * chain of accessors.
 *
 * Trace/span identifiers (`.trace_id`, `.span_id`, `.parent_span_id`) are hex strings — matching
 * `SpanEvent.traceIdHex`/`spanIdHex` — and, like `.duration` and `.annotations`/`.links`, are
 * **read-only** (see {@link spanReadonlyPaths}): a program can branch on a span's identity or
 * shape, but cannot forge a different one, retime it after the fact, or rewrite the record of what
 * happened during it. `.name`, `.kind`, `.status`, `.attributes`, `.resource`, `.start_time`,
 * `.end_time`, and `.trace_state` are writable.
 *
 * `.attributes` and `.resource` are open objects (`rest: any`, matching `SpanEvent.attributes`/
 * `.resource: ValueMap`) — any key, any OTLP-attribute-shaped value (`span/view.ts`'s
 * `applyViewToSpan` validates that constraint at write-back, the same "checker is best-effort,
 * write-back is the real enforcement" split design.md's metric-events section already documents
 * for `.tags`). `.annotations`/`.links` use the fixed shapes below; both are read-only, so there is
 * no equivalent write-time validation for them — a program can only observe what the span already
 * carries.
 */

/** `{ name: string, time: timestamp, attributes: object { ..any } }` — one span annotation (OTLP
 * "span event"), read-only via `.annotations`. */
export const SPAN_ANNOTATION_SHAPE: Type = objectType({
  name: stringType,
  time: timestampType,
  attributes: objectType({}, anyType),
});

/** `{ trace_id: string, span_id: string, trace_state: string | null, attributes: object { ..any } }`
 * — one link to another span, read-only via `.links`. IDs are hex strings, matching the span's
 * own `.trace_id`/`.span_id`. */
export const SPAN_LINK_SHAPE: Type = objectType({
  trace_id: stringType,
  span_id: stringType,
  trace_state: unionType([stringType, nullType]),
  attributes: objectType({}, anyType),
});

/** `{ code: string, message: string | null }` — a span's status. `code` is validated at
 * write-back to be `"unset"`, `"ok"`, or `"error"` (`@ferrule/core`'s `SpanStatus['code']`); the
 * checker only knows it as `string` (see the module doc's "checker is best-effort" note). */
export const SPAN_STATUS_SHAPE: Type = objectType({
  code: stringType,
  message: unionType([stringType, nullType]),
});

/** An open object of any shape: `object { ..any }`, used for `.attributes`/`.resource` and the
 * nested `attributes` field of an annotation/link. */
const OPEN_ATTRIBUTES_SHAPE: Type = objectType({}, anyType);

let cachedSchema: Type | undefined;

/**
 * The span event's root object type, for `check`'s `inputSchema`. Closed (no `rest`): a span has
 * no backing store for an arbitrary extra field, so a name outside this set is a compile-time "no
 * such field" error (`resolveWritePathType` in `check/checker.ts`) on a write, and reads as `null`
 * (same permissiveness `pathType` already gives an unknown path) on a read.
 *
 * `.scope` (the span's `InstrumentationScope`) is not exposed here — a documented, currently
 * unimplemented follow-up, parallel to the metric view's "not narrowed to `.value_type`" gap.
 */
export function spanEventSchema(): Type {
  if (cachedSchema === undefined) {
    cachedSchema = objectType({
      trace_id: stringType,
      span_id: stringType,
      parent_span_id: unionType([stringType, nullType]),
      trace_state: unionType([stringType, nullType]),
      name: stringType,
      kind: stringType,
      start_time: timestampType,
      end_time: timestampType,
      duration: intType,
      status: SPAN_STATUS_SHAPE,
      attributes: OPEN_ATTRIBUTES_SHAPE,
      resource: OPEN_ATTRIBUTES_SHAPE,
      annotations: arrayType(SPAN_ANNOTATION_SHAPE),
      links: arrayType(SPAN_LINK_SHAPE),
    });
  }
  return cachedSchema;
}

/**
 * Top-level span fields a program can read but never assign, for `CheckOptions.readonlyPaths`:
 * span/trace identifiers (assigned once, by the tracing system, not by a transform), `.duration`
 * (derived from `.start_time`/`.end_time`, never stored directly — see `span/view.ts`'s
 * `applyViewToSpan`), and `.annotations`/`.links` (a record of what already happened, not
 * something a program rewrites). `check/checker.ts`'s `checkPathAssignTarget` blocks a write
 * through *any* path whose first segment names one of these, not just a bare `.annotations = ...`
 * reassignment — so `.annotations[0].attributes.x = 1` is rejected too, which matters here in a way
 * it didn't for the metric view's single read-only field (`.value_type`, a flat string with no
 * deeper segment to write through in the first place).
 */
export function spanReadonlyPaths(): ReadonlyMap<string, string> {
  const idMessage =
    "' is read-only: span and trace IDs are assigned by the tracing system, not a transform";
  return new Map([
    ['trace_id', `cannot assign to '.trace_id${idMessage}`],
    ['span_id', `cannot assign to '.span_id${idMessage}`],
    ['parent_span_id', `cannot assign to '.parent_span_id${idMessage}`],
    [
      'duration',
      "cannot assign to '.duration': it is derived from '.start_time'/'.end_time', not stored " +
        'directly — assign those instead',
    ],
    ['annotations', "cannot assign to '.annotations': span annotations are read-only here"],
    ['links', "cannot assign to '.links': span links are read-only here"],
  ]);
}
