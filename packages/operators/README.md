# `@ferrule/operators`

Built-in Ferrule transforms that don't need Ferrule Script: field remapping, sampling,
throttling, deduplication, metric aggregation, log/metric conversion, cardinality limiting, log
windowing, trace tail sampling, event-kind splitting, and metric tag helpers. `script`, `filter`,
and `route` (which need compiled script conditions) are not part of this package; everything here
is configured with plain, typed options — never a mini-language.

Node.js standard library only — no runtime dependencies beyond `@ferrule/core`, `@ferrule/schema`,
and `@ferrule/runtime`.

```ts
import { builtinOperators } from '@ferrule/operators';
import { ComponentRegistry } from '@ferrule/runtime';

const registry = new ComponentRegistry();
registry.register(...builtinOperators());
```

## Contents

- [Shared concepts](#shared-concepts)
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
