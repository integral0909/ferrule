# `@ferrule/operators`

Built-in Ferrule transforms: `script`, `filter`, and `route` (which compile and run Ferrule
Script), plus a set of transforms that don't need it — field remapping, sampling, throttling,
deduplication, metric aggregation, log/metric conversion, cardinality limiting, log windowing,
trace tail sampling, event-kind splitting, and metric tag helpers — configured entirely with
plain, typed options.

Node.js standard library only — no runtime dependencies beyond `@ferrule/core`, `@ferrule/schema`,
`@ferrule/runtime`, and `@ferrule/script`.

```ts
import { builtinOperators } from '@ferrule/operators';
import { ComponentRegistry } from '@ferrule/runtime';

const registry = new ComponentRegistry();
registry.register(...builtinOperators());
```

## Contents

- [Shared concepts](#shared-concepts)
- [`script`](#script)
- [`filter`](#filter)
- [`route`](#route)
- [`remap_fields`](#remap_fields)
- [`sample`](#sample)
- [`throttle`](#throttle)
- [`dedupe`](#dedupe)
- [`aggregate`](#aggregate)
- [`log_to_metric`](#log_to_metric)
- [`metric_to_log`](#metric_to_log)
- [`cardinality_limit`](#cardinality_limit)
- [`window_reduce`](#window_reduce)
- [`tail_sampling`](#tail_sampling)
- [`split_by_kind`](#split_by_kind)
- [`metric_tags`](#metric_tags)
- [Known gaps](#known-gaps)

## Shared concepts

**Field paths.** Any option typed as a field path (`s.fieldPath()`) uses the same syntax as the
rest of Ferrule: `.field`, `field.nested`, `field[0]`, `field."quoted key"`. See `@ferrule/core`'s
`parsePath`.

**Field conditions, not a language.** `window_reduce` (group start/end) and `tail_sampling` (the
`attribute` policy) test fields with a small, typed condition tree instead of a scripting
language:

```yaml
{ type: field_exists, field: some.path }
{ type: field_equals, field: status, value: 500 }
{ type: field_matches, field: message, pattern: '^ERROR' } # regex on a string field
{ type: and, conditions: [ ... ] }
{ type: or, conditions: [ ... ] }
{ type: not, condition: { ... } }
```

**Templates.** Wherever an option renders text from event data (`log_to_metric`'s metric/tag
names, `metric_tags`' `add_tags`/`rename_metric`/`set_namespace`), it's a `{field.path}` template:
literal text with `{...}` substitutions; `{{`/`}}` escape a literal brace. Missing fields render
as an empty string.

**Finalizer/acknowledgement contract.** Every operator here follows the same rules as any Ferrule
transform (see `packages/runtime/README.md`):

- An event that is **pushed onward** transfers its finalizers to whatever consumes it next; the
  operator does nothing further.
- An event that is **intentionally dropped** (sampled out, throttled, a duplicate, over a
  cardinality limit) has its finalizers finished `delivered` — the pipeline did what it was
  configured to do.
- An event **discarded under memory pressure** (a capacity cap forcing eviction of state that was
  never going to be flushed) is finished `errored`, matching the runtime's own channel
  `drop_newest` behaviour, so a source can tell the difference from an intentional drop.
- An operator that **combines several events into one** (`aggregate`, `window_reduce`) merges
  every contributing event's finalizers into the one event it produces, so acknowledgement
  completes only once that combined event is actually delivered.
- An operator that **fans one event out into several** (`log_to_metric`) clones the finalizers
  onto each output event, exactly like routing one event to multiple sinks.

## `script`

Runs a compiled [Ferrule Script](../script/README.md) program over every log event. The program
is parsed, checked, and compiled once at **build time** (validation, before the pipeline starts),
so a syntax or type error is reported immediately with the same rendered code frames
`ferrule validate`/the language package produce, as a thrown `FerruleError`.

| Option            | Type                          | Default | Description                                                                                                                     |
| ----------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | string                        | —       | inline Ferrule Script source (exactly one of `source`/`file`)                                                                   |
| `file`            | string                        | —       | path to a `.fer` file, read once at build time                                                                                  |
| `input_schema`    | map of field name → type name | —       | see below                                                                                                                       |
| `drop_on_abort`   | boolean                       | `false` | deliberate `abort()`/type-mismatch: drop+count vs. route to `errors`                                                            |
| `drop_on_error`   | boolean                       | `false` | resource-limit/internal-error abort: drop+count vs. route to `errors`                                                           |
| `reroute_dropped` | boolean                       | `false` | route `drop()`ped events to the `dropped` port instead of finishing them                                                        |
| `metrics`         | boolean                       | `false` | run the program over metric events instead of log events (log/span then pass through); see below                                |
| `limits`          | object                        | `{}`    | per-event resource limit overrides (`max_string_length`, `max_collection_size`, `max_regex_input_length`, `max_emitted_events`) |

`input_schema` is a **flat** field → type-name map (`null`/`bool`/`int`/`float`/`string`/`bytes`/
`timestamp`/`array`/`object`/`any`), converted to a Ferrule object type (`objectType(fields,
anyType)`): it types the top-level fields it names; anything else stays `any`, and named
`array`/`object` fields stay fully open (no nested element typing) — see
`docs/language/design.md` §3 for the default-`any` behaviour this narrows. It only applies to log
events; it is rejected at config time together with `metrics: true`.

**One instance runs its program over exactly one event kind; the other kinds pass through**,
counted by `script_passthrough_events_total` (tagged `kind`). By default that's log events (span
events always pass through — `@ferrule/script` has no span view); setting `metrics: true` checks
and runs the program against the metric view instead (`docs/language/design.md`'s "Metric events",
`@ferrule/script`'s `metric/schema.ts`/`metric/view.ts`) and flips the passthrough to log/span. A
metric that aborts (including a write the script produced that doesn't validate once the program
finishes, e.g. a non-string tag value) routes the metric's log-shaped view — not the `MetricEvent`,
which has no field bag to attach `ferrule.error.*` to — to the `errors` port, sharing the original
metric's finalizers.

**Outcomes**, per `CompiledProgram.run`'s `Outcome`:

- `continue` — the (possibly mutated) input event is pushed on the default port; any `emit()`-
  added events are pushed too, each with a _clone_ of the original event's finalizers merged in,
  so the upstream batch acknowledges only once every derived event finishes.
- `drop` — finished `delivered` (the ordinary intentional-drop status), or routed to the `dropped`
  port if `reroute_dropped` is set.
- `abort` — the failure reason's prefix distinguishes a deliberate abort/mismatch (`drop_on_abort`)
  from a resource limit or genuine bug (`limit exceeded: `/`internal error: `, `drop_on_error`).
  Unless the applicable flag is `true` (finish `rejected`, counted under
  `component_discarded_events_total`), the event is routed to the always-declared `errors` port
  with the failure recorded on the event itself: `ferrule.error.reason` (string),
  `ferrule.error.span.start`/`.end` (int, UTF-16 offsets into the script source), and
  `ferrule.error.transform` (this component's ID).

Metrics: `script_events_total` (tag `outcome: continue|drop|abort`) and
`script_run_duration_seconds` (a histogram), both recorded per processed event (log, or metric
with `metrics: true`).

```yaml
transforms:
  shape:
    type: script
    inputs: [app_logs]
    source: |
      .service = .service ?? "unknown"
      if .level == "debug" { drop }
    drop_on_abort: false
  shape_errors:
    type: console # or any sink
    inputs: [shape.errors]
  tag_metrics:
    type: script
    inputs: [raw_metrics]
    metrics: true
    source: |
      .tags.service = "checkout"
```

## `filter`

Keeps log events for which a Ferrule Script boolean **expression** (not a full program) is true.

| Option         | Type                          | Default | Description                                          |
| -------------- | ----------------------------- | ------- | ---------------------------------------------------- |
| `condition`    | string                        | —       | a Ferrule Script boolean expression                  |
| `on_error`     | `keep` \| `drop`              | `drop`  | what an aborted condition means (see below)          |
| `input_schema` | map of field name → type name | —       | same shape as `script`'s, used to type the condition |

**Compilation approach.** `condition` is spliced into a tiny synthetic program that uses the
language's own control flow rather than a scratch field: `if !((<condition>) ?? <on_error
fallback>) { drop }`. Ferrule Script's checker only _warns_ (never errors) when `??` is applied to
an already-non-fallible left side, so this compiles unchanged whether or not `condition` can fail.
`Outcome.kind` then **is** the decision: `continue` keeps the event (original finalizers intact,
plus any `emit()`-added events, exactly like `script`); `drop` discards it, finished `delivered`.

A **`Failure`** (a fallible sub-expression, e.g. `to_int(.x) > 5` when `.x` isn't numeric) is
caught by the `?? fallback` above and becomes an ordinary `true`/`false`. An **`abort`** (an
explicit `abort()`, or an `any`-typed operand that isn't the kind an operator needs at runtime —
not interceptable by `??`) is handled by `on_error`: `keep` pushes the event through as if it had
matched; `drop` (the default) finishes it `rejected` — this is "bad data", the same
permanent-failure semantics `remap_fields`'s `on_error: drop` uses — and counts it under
`component_discarded_events_total` (`reason: condition_aborted`).

Known limitation: a compile error's reported position is an offset into the synthetic wrapper
source, not `condition` alone — the code frame still shows the right text and column, with the
wrapper visible around it.

```yaml
transforms:
  only_errors:
    type: filter
    inputs: [app_logs]
    condition: '.status >= 500'
```

## `route`

Sends each log event to every named route whose Ferrule Script condition is true, using the same
compilation approach as `filter` (one wrapped program per route). A route's port is its own name.

| Option            | Type                           | Default        | Description                                                        |
| ----------------- | ------------------------------ | -------------- | ------------------------------------------------------------------ |
| `routes`          | array of `{ name, condition }` | —              | at least one; names must be unique                                 |
| `on_error`        | `keep` \| `drop`               | `drop`         | what an aborted route condition means for _that route's_ match     |
| `route_unmatched` | boolean                        | `true`         | route events matching no route to `unmatched_port`                 |
| `unmatched_port`  | string                         | `"_unmatched"` | port for events matching no route (used only if `route_unmatched`) |
| `input_schema`    | map of field name → type name  | —              | same shape as `script`'s, used to type every condition             |

Every route's condition is evaluated independently against the **original** event: a condition is
a single expression, and the grammar has no way to put an assignment statement inside an
expression, so no route's condition can mutate a field another route reads. An event matching
several routes is fanned out to all of them — the first match reuses the original event object,
every later match is `LogEvent.clone()` (which already clones finalizers), so the upstream batch
acknowledges only once every copy finishes. A route condition that calls `emit()` is a known,
documented gap: the extra event is discarded, since with several routes possibly matching there is
no single obvious port for it — write route conditions as pure predicates.

```yaml
transforms:
  by_status:
    type: route
    inputs: [app_logs]
    routes:
      - { name: errors, condition: '.status >= 500' }
      - { name: client_errors, condition: '.status >= 400 && .status < 500' }
    unmatched_port: ok
sinks:
  error_sink:
    type: console
    inputs: [by_status.errors]
  ok_sink:
    type: console
    inputs: [by_status.ok]
```

## `remap_fields`

Declarative field operations on log events — rename, copy, move, delete, set a constant, or
coerce a type — applied in order. No scripting.

| Option       | Type                        | Default | Description                          |
| ------------ | --------------------------- | ------- | ------------------------------------ |
| `operations` | array of operations (below) | —       | applied in order                     |
| `on_error`   | `drop` \| `route` \| `keep` | `keep`  | what happens when an operation fails |

Operations (`op` discriminates):

| `op`     | Fields                                                                                                                                                              | Behaviour                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `rename` | `from`, `to` (field paths)                                                                                                                                          | moves a field, error if `from` is missing             |
| `copy`   | `from`, `to`                                                                                                                                                        | duplicates a field, error if `from` is missing        |
| `move`   | `from`, `to`                                                                                                                                                        | identical to `rename`                                 |
| `delete` | `field`                                                                                                                                                             | removes a field (no error if already absent)          |
| `set`    | `field`, `value` (any JSON-compatible value)                                                                                                                        | writes a constant                                     |
| `coerce` | `field`, `to` (`int`\|`float`\|`string`\|`bool`\|`timestamp`), `format` (timestamp only: `rfc3339`\|`unix_seconds`\|`unix_millis`\|`unix_nanos`, default `rfc3339`) | converts a field's type in place, error if unparsable |

`on_error: route` declares an `errors` output port. `drop` finishes the event `rejected`; `keep`
leaves the failed operation's field untouched and continues with the rest.

```yaml
transforms:
  shape:
    type: remap_fields
    inputs: [app_logs]
    operations:
      - { op: rename, from: lvl, to: level }
      - { op: coerce, field: status, to: int }
      - { op: set, field: source, value: edge }
      - { op: delete, field: debug }
    on_error: keep
```

## `sample`

Deterministic sampling by rate.

| Option      | Type                         | Default | Description                                            |
| ----------- | ---------------------------- | ------- | ------------------------------------------------------ |
| `rate`      | number, 0–1                  | `1`     | fraction of events to keep                             |
| `key_field` | field path, optional         | —       | keep/drop whole keys consistently instead of per-event |
| `exclude`   | array of `{ field, values }` | `[]`    | always keep a match, bypassing `rate`                  |

Without `key_field`, sampling uses an error-diffusion counter: of any `N` consecutive events it
keeps a count that never strays from `rate * N` by more than one, deterministically, with no
randomness. With `key_field`, all events sharing the same rendered field value get the same
decision (a stable hash of the value compared against `rate`), so sampling can keep whole traces,
sessions, or users together.

```yaml
transforms:
  sample_10pct:
    type: sample
    inputs: [app_logs]
    rate: 0.1
    key_field: trace_id
    exclude:
      - field: http.status
        values: ['500', '502', '503', '504']
```

## `throttle`

A per-key token bucket rate limiter.

| Option         | Type                 | Default  | Description                                                        |
| -------------- | -------------------- | -------- | ------------------------------------------------------------------ |
| `threshold`    | integer, ≥1          | `1000`   | maximum events per key per window                                  |
| `window`       | duration             | `1000ms` | the rate-limiting window                                           |
| `key_field`    | field path, optional | —        | omit for one bucket shared by every event                          |
| `max_keys`     | integer, ≥1          | `100000` | LRU cap on distinct keys tracked; eviction resets a key's budget   |
| `emit_dropped` | boolean              | `false`  | route throttled events to the `dropped` port instead of discarding |

```yaml
transforms:
  per_ip_limit:
    type: throttle
    inputs: [app_logs]
    threshold: 100
    window: 1s
    key_field: client.ip
    emit_dropped: true
```

## `dedupe`

Drops log events that duplicate one recently seen, based on a fingerprint of selected fields.

| Option          | Type                           | Default   | Description                                                   |
| --------------- | ------------------------------ | --------- | ------------------------------------------------------------- |
| `fields`        | array of field paths, optional | —         | dedupe key fields; default: every field minus `ignore_fields` |
| `ignore_fields` | array of field paths           | `[]`      | fields excluded from the key when `fields` is not given       |
| `cache_size`    | integer, ≥1                    | `100000`  | LRU cap on remembered fingerprints                            |
| `ttl`           | duration                       | `60000ms` | how long a fingerprint is remembered                          |

```yaml
transforms:
  dedupe_errors:
    type: dedupe
    inputs: [app_logs]
    fields: [message, service]
    cache_size: 50000
    ttl: 1m
```

## `aggregate`

Combines metric events per series over a tumbling window, flushed on tick.

| Option                            | Type               | Default         | Description                                                        |
| --------------------------------- | ------------------ | --------------- | ------------------------------------------------------------------ |
| `interval`                        | duration           | `10000ms`       | window length; a series' aggregate flushes once per interval       |
| `convert_absolute_to_incremental` | boolean            | `false`         | turn absolute readings into deltas before summing (handles resets) |
| `convert_incremental_to_absolute` | boolean            | `false`         | emit a running total instead of each window's sum                  |
| `max_series`                      | integer, ≥1        | `100000`        | LRU cap on distinct series tracked at once                         |
| `stale_after`                     | duration, optional | `10 × interval` | evict a series not updated in this long                            |

Incremental readings (counters, sets, distributions, histograms) are summed within the window.
Absolute readings (gauges, cumulative counters as scraped) are kept as their latest value within
the window unless `convert_absolute_to_incremental` is set, in which case each new absolute
reading becomes a delta from the previous one (with counter-reset detection), then summed like
any other incremental value. A series with no updates since the last flush is not re-emitted.

```yaml
transforms:
  rollup_10s:
    type: aggregate
    inputs: [raw_metrics]
    interval: 10s

  scrape_to_deltas:
    type: aggregate
    inputs: [prometheus_scrape]
    interval: 1m
    convert_absolute_to_incremental: true
```

## `log_to_metric`

Derives one or more metrics from each log event's fields. The original log event is consumed, not
forwarded. `name`, `namespace`, and tag values are `{field.path}` templates.

| Option    | Type                          | Description  |
| --------- | ----------------------------- | ------------ |
| `metrics` | array of metric specs (below) | at least one |

Every spec has `name`, `namespace` (optional), and `tags` (map of name → template). By `type`:

| `type`         | Extra fields                                                       | Behaviour                                                 |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `counter`      | `field` (optional), `increment_by_value` (default `false`)         | +1, or +field's numeric value if `increment_by_value`     |
| `gauge`        | `field`                                                            | absolute reading from the field's numeric value           |
| `set`          | `field`                                                            | the field's rendered text becomes the set's single member |
| `histogram`    | `field`, `buckets` (strictly increasing upper bounds)              | one observation into the matching bucket                  |
| `distribution` | `field`, `statistic` (`histogram`\|`summary`, default `histogram`) | one weighted sample                                       |

A spec whose `field` is missing on a given event is silently skipped for that event.

```yaml
transforms:
  derive_metrics:
    type: log_to_metric
    inputs: [app_logs]
    metrics:
      - type: counter
        name: http.requests
        tags: { status: '{http.status}' }
      - type: histogram
        name: http.request.duration_ms
        field: duration_ms
        buckets: [5, 10, 25, 50, 100, 250, 500, 1000]
```

## `metric_to_log`

The inverse of `log_to_metric`: represents each metric event as one log event. One metric always
becomes exactly one log event, so the log's finalizers are the metric's own (moved, not cloned).

| Option  | Type       | Default   | Description                                      |
| ------- | ---------- | --------- | ------------------------------------------------ |
| `field` | field path | `.metric` | field the metric representation is written under |

Output shape (all under `field`):

```yaml
metric:
  name: string
  namespace: string?
  tags: { [key]: string }
  kind: incremental | absolute
  timestamp: timestamp?
  value:
    type: counter | gauge | set | distribution | histogram | summary
    value: number # counter, gauge
    values: [string] # set
    samples: [{ value, rate }] # distribution
    buckets: [{ upper_limit, count }], count, sum # histogram
    quantiles: [{ quantile, value }], count, sum # summary
```

```yaml
transforms:
  metrics_as_logs:
    type: metric_to_log
    inputs: [internal_metrics]
    field: m
```

## `cardinality_limit`

Caps the number of distinct tag-value combinations allowed per metric name.

| Option                      | Type                       | Default      | Description                                            |
| --------------------------- | -------------------------- | ------------ | ------------------------------------------------------ |
| `limit`                     | integer, ≥1                | `1000`       | maximum distinct combinations per metric name          |
| `mode`                      | `exact` \| `probabilistic` | `exact`      | exact `Set` tracking, or a bounded-memory Bloom filter |
| `policy`                    | `drop_event` \| `drop_tag` | `drop_event` | what happens to an event beyond the limit              |
| `drop_tag_keys`             | array of strings, optional | every tag    | tag keys stripped when `policy: drop_tag`              |
| `bloom_false_positive_rate` | number, (0, 0.5]           | `0.01`       | target false-positive rate for `mode: probabilistic`   |
| `max_series_tracked`        | integer, ≥1                | `10000`      | LRU cap on distinct metric names tracked at once       |

`mode: exact` tracks every combination with a `Set`, giving exact limiting at `O(limit)` memory
per metric name. `mode: probabilistic` instead tracks combinations with a Bloom filter sized for
`limit` at `bloom_false_positive_rate`, trading a small, bounded chance of under-counting for
memory that does not grow with the number of _rejected_ combinations.

```yaml
transforms:
  limit_cardinality:
    type: cardinality_limit
    inputs: [raw_metrics]
    limit: 5000
    policy: drop_tag
    drop_tag_keys: [user_id]
```

## `window_reduce`

Merges log events that belong together (multiline stack traces, request/response pairs) into one.

| Option             | Type                                      | Default | Description                                                                                              |
| ------------------ | ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `group_by`         | array of field paths                      | —       | fields whose values form the group key                                                                   |
| `start_when`       | condition, optional                       | —       | flush an existing open group for this key before starting a new one                                      |
| `end_when`         | condition, optional                       | —       | flush the group immediately on match                                                                     |
| `merge_strategies` | array of `{ field, strategy, separator }` | `[]`    | per-field merge strategy; `strategy` is `concat`\|`array`\|`sum`\|`max`\|`min`\|`first`\|`last`\|`count` |
| `base_event`       | `first` \| `last`                         | `first` | which event supplies fields not covered by `merge_strategies`                                            |
| `max_events`       | integer, ≥1, optional                     | —       | flush after this many events accumulate                                                                  |
| `max_bytes`        | byte size, optional                       | —       | flush after the group reaches this estimated size                                                        |
| `max_duration`     | duration, optional                        | —       | flush this long after the group started (checked on tick)                                                |

Without `end_when`, a group flushes on `max_events`, `max_bytes`, `max_duration`, or pipeline
shutdown. The merged event carries the group's finalizers merged together.

```yaml
transforms:
  fold_stack_traces:
    type: window_reduce
    inputs: [app_logs]
    group_by: [thread]
    end_when:
      type: not
      condition: { type: field_matches, field: message, pattern: '^\s' }
    merge_strategies:
      - { field: message, strategy: concat, separator: "\n" }
    max_events: 500
    max_duration: 5s
```

## `tail_sampling`

Buffers spans per trace ID until the trace looks complete (a root span seen and no new span for
`quiet_period`) or `decision_wait` elapses, then decides whether to keep the whole trace using
composable policies, combined with OR.

| Option                | Type              | Default  | Description                                                               |
| --------------------- | ----------------- | -------- | ------------------------------------------------------------------------- |
| `decision_wait`       | duration          | `5000ms` | force a decision this long after a trace is first seen                    |
| `quiet_period`        | duration          | `2000ms` | once a root span is seen, decide this long after the most recent span     |
| `max_traces`          | integer, ≥1       | `50000`  | maximum traces buffered at once (LRU-evicted via an early decision)       |
| `max_spans_per_trace` | integer, ≥1       | `10000`  | maximum spans buffered per trace (forces an early decision, no data loss) |
| `max_bytes`           | byte size         | `256MiB` | maximum total estimated size of buffered spans                            |
| `decision_cache_size` | integer, ≥1       | `200000` | decisions remembered for late-arriving spans (LRU)                        |
| `policies`            | array of policies | `[]`     | combined with OR; empty samples every trace                               |

Policies (`type` discriminates):

| `type`               | Fields                                                                | Samples when...                                                             |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `status_error`       | —                                                                     | any span in the trace has `status: error`                                   |
| `latency`            | `threshold` (duration), `scope` (`root`\|`any`, default `root`)       | a span's duration is ≥ `threshold`                                          |
| `probabilistic`      | `rate` (0–1)                                                          | deterministically, by hashing the trace ID                                  |
| `attribute`          | `condition` (field condition), `scope` (`root`\|`any`, default `any`) | a span matches; field paths use `attributes.*`/`resource.*`/`name`/`status` |
| `rate_limit`         | `spans_per_second`                                                    | a shared token bucket has budget for the trace's spans                      |
| `and` / `or` / `not` | `policies` / `policies` / `policy`                                    | logical composition of nested policies                                      |

Memory is bounded without losing spans: `max_spans_per_trace`, `max_bytes`, and `max_traces` all
force an _earlier_ decision for the affected trace (using whatever spans it has so far) rather
than dropping anything; later spans for that trace then follow the cached decision like any other
late arrival.

```yaml
transforms:
  tail_sample:
    type: tail_sampling
    inputs: [raw_spans]
    decision_wait: 10s
    quiet_period: 3s
    policies:
      - { type: status_error }
      - { type: latency, threshold: 500ms, scope: any }
      - { type: probabilistic, rate: 0.05 }
```

## `split_by_kind`

Routes logs, metrics, and spans to separate output ports.

| Option        | Type   | Default   | Description                    |
| ------------- | ------ | --------- | ------------------------------ |
| `log_port`    | string | `logs`    | port log events are sent to    |
| `metric_port` | string | `metrics` | port metric events are sent to |
| `span_port`   | string | `spans`   | port span events are sent to   |

```yaml
transforms:
  split:
    type: split_by_kind
    inputs: [mixed_telemetry]

sinks:
  logs_sink:
    type: console
    inputs: [split.logs]
  metrics_sink:
    type: console
    inputs: [split.metrics]
```

## `metric_tags`

Adds, removes, or renames metric tags; renames a metric; sets a namespace. Operations apply in a
fixed order — `remove_tags`, then `rename_tags`, then `add_tags`, then `rename_metric` /
`set_namespace` — so a rename can reuse a tag `add_tags` just introduced. `add_tags` values and
`rename_metric`/`set_namespace` are templates rendered against the metric's own `name`,
`namespace`, and `tags.<key>` (using values as they stand at that point in the sequence).

| Option          | Type                   | Default | Description                         |
| --------------- | ---------------------- | ------- | ----------------------------------- |
| `add_tags`      | map of name → template | `{}`    | tags to add or overwrite            |
| `remove_tags`   | array of strings       | `[]`    | tag names to remove                 |
| `rename_tags`   | map of old → new name  | `{}`    | renames a tag, preserving its value |
| `rename_metric` | template, optional     | —       | new metric name                     |
| `set_namespace` | template, optional     | —       | new namespace                       |

```yaml
transforms:
  relabel:
    type: metric_tags
    inputs: [raw_metrics]
    set_namespace: infra
    rename_tags: { host: hostname }
    add_tags: { env: production }
    remove_tags: [internal_id]
```

## Known gaps

- `script`'s `input_schema` is a flat field → type-name map; there is no nested object/array
  element typing (a named `array`/`object` field stays fully open).
- `script` never runs the same program against both log and metric events — `metrics: true`
  switches which kind it handles, it doesn't add a second one — and span events have no view at
  all yet, so they always pass through untouched (see the script package README's "Execution
  model").
- The metric view types every value-type's field(s) together rather than narrowing to the event's
  actual `.value_type`; declaring the specific value type up front (to make, say, `.buckets` a
  compile-time error on a counter) is a documented, currently unimplemented follow-up
  (`@ferrule/script`'s `metric/schema.ts`).
- `filter`/`route` compile `condition` inside a synthetic wrapper program
  (`if !((<condition>) ?? <fallback>) { drop }`); a compile error's position is reported against
  that wrapper, not the bare `condition` string.
- `route` discards any event an `emit()` call inside a route condition adds — conditions are
  expected to be pure predicates; use `script` (which fully supports `emit()`) ahead of `route` if
  you need to both derive and route additional events.
- `sample`'s `key_field` and `exclude`, and `throttle`'s `key_field`, address log fields directly
  but only a small fixed set of paths for metrics (`name`, `namespace`, `tags.<key>`) and spans
  (`name`, `status`, `attributes.*`, `resource.*`); an arbitrary nested span attribute path works,
  but there is no generic field-path addressing across all three event kinds the way `LogEvent`
  has.
- `cardinality_limit`'s `drop_tag` policy strips tags and re-checks the reduced combination once;
  if the reduction still collides with an existing tracked combination for another event under
  the same reduced key, the event is still emitted (best effort) rather than retried further.
- `window_reduce`'s merge strategies operate over the group's buffered events in memory; there is
  no cap on total buffered bytes independent of `max_bytes` per group (i.e. no cross-group memory
  cap the way `tail_sampling` has one).
- `tail_sampling`'s Bloom-filter-free exact `cardinality_limit` and the Bloom filter itself are
  this package's own implementations (not a shared dependency); their false-positive/negative
  trade-offs are documented in `src/util/bloom.ts` and are appropriate for cardinality limiting
  but are not a general-purpose probabilistic data structure library.
