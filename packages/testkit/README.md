# `@ferrule/testkit`

Utilities for testing Ferrule pipelines and custom components: the pipeline test-file runner
behind `ferrule test`, inline `script`-transform test-block discovery, human/JUnit/JSON
reporters, component test harnesses (`testSource`/`testTransform`/`testSink`), event builders, and
value-diff assertion helpers.

Node.js standard library only — no runtime dependencies beyond `@ferrule/core`, `@ferrule/schema`,
`@ferrule/runtime`, `@ferrule/script`, and `@ferrule/config`.

## Contents

- [Test file format](#test-file-format)
- [Running test files programmatically](#running-test-files-programmatically)
- [Inline script tests](#inline-script-tests)
- [Reporters](#reporters)
- [Component harnesses](#component-harnesses)
- [Event builders](#event-builders)
- [Value-diff assertion helpers](#value-diff-assertion-helpers)
- [Known gaps](#known-gaps)

## Test file format

A test file is YAML, loaded with `@ferrule/config`'s position-tracking parser (so a failing
expectation's message and the file's own schema errors can both be rendered as code frames):

```yaml
# app.test.yaml
config: ./app.yaml # the pipeline config under test, resolved relative to this file
description: optional free text

cases:
  - name: keeps 2xx, drops 5xx
    inputs:
      app_logs: # a source component ID in the pipeline config
        - { status: 200, method: GET }
        - { status: 500 }
    outputs:
      store: # a sink component ID in the pipeline config
        count: 1
        match: subset # or exact; default subset
        events:
          - { status: 200 }
        conditions:
          - '.status < 300' # a Ferrule Script boolean expression

  - name: nothing reaches the errors sink
    inputs:
      app_logs:
        - { status: 200 }
    outputs:
      store_errors:
        none: true
```

### Building the topology

`runTestFile`/`runFerruleTests` load the pipeline config named by `config` with the **real**
registry you pass in (so genuine config mistakes — an unknown type, a bad option — are caught
exactly like `ferrule validate` would catch them), then build a **test topology** from it: every
source is replaced by an injection point and every sink by a collector, so no network is ever
touched. Each case gets its own fresh `Pipeline` and `ManualClock`; cases never share state.

### `inputs`

`inputs.<componentId>` is a list of events injected at that source, in order, sent in one batch
right after the pipeline starts. Each item is one of:

- **a plain object** — a log event's fields (`{ status: 200 }` → `LogEvent.from({ status: 200 })`).
- **a plain string** — a log event's `message` field (the closest practical stand-in for "decoded
  by the source's real codec": `@ferrule/testkit` does not depend on `@ferrule/codecs` and has no
  way to know which codec a given source type would actually use — see "Known gaps").
- **an object with `event_kind: metric`** — `{ event_kind: metric, name, namespace?, tags?, value:
{ type: counter|gauge|set, value?, values? } }`.
- **an object with `event_kind: span`** — `{ event_kind: span, name, trace_id?, span_id?,
parent_span_id?, duration_ms?, status?, attributes? }` (hex strings for IDs).

An unknown component ID under `inputs` (not a source in the pipeline config) fails the case with a
clear message rather than silently doing nothing.

### `outputs`

`outputs.<componentId>` is an expectation against everything a **sink** collected during the case
(a transform's own output port is not directly addressable — wire it to a dedicated sink in the
pipeline config under test if you want to assert on it, the same way a real pipeline would route
it somewhere). Every field is optional; only the ones you set are checked:

| Field        | Type                | Meaning                                                                          |
| ------------ | ------------------- | -------------------------------------------------------------------------------- |
| `none`       | boolean             | expect zero events                                                               |
| `count`      | integer             | expect exactly this many events                                                  |
| `match`      | `exact` \| `subset` | how `events` compares (default `subset`)                                         |
| `events`     | array               | expected events, compared positionally against what was collected                |
| `conditions` | array of strings    | Ferrule Script boolean expressions, each evaluated against every collected event |

`events[i]` is compared against the `i`th collected event using the same value equality
`@ferrule/core`'s `valuesEqual` uses everywhere else (`1` ≠ `1.0`, object key order irrelevant). In
`subset` mode (the default) `events[i]` only needs to name the fields you care about; `exact` mode
also fails if the actual event has a field `events[i]` doesn't mention. A log event compares
directly against its fields (`{ status: 200 }`); a metric or span event compares against a
synthesized shape (`{ name, namespace?, tags, kind, value }` for a metric; `{ trace_id, span_id,
parent_span_id?, name, span_kind, status, attributes, resource }` for a span — hex strings for
IDs), so an `events` entry for one of those uses that same shape, with no `event_kind` tag needed
(unlike `inputs`, there's nothing to disambiguate: the shape is already determined by what kind of
event the sink actually collected).

`conditions` only evaluate against **log** events (Ferrule Script's compiler doesn't support
metric/span events; see `@ferrule/script`'s README). A condition that fails to compile, that
aborts at runtime (an explicit `abort()` or an `any`-typed mismatch), or that evaluates to `false`
all fail the case, each with its own message.

### `advance_clock`

```yaml
cases:
  - name: aggregate flushes after the window
    inputs:
      raw_metrics: [...]
    advance_clock: 10s
    outputs:
      rollup:
        count: 1
```

Each case runs against a fresh `ManualClock`. `advance_clock` (a duration, like any other Ferrule
duration option) advances it once, after every input is sent and before the pipeline is drained —
enough for a tick-interval transform (`aggregate`, `window_reduce`, ...) to fire. There is no way
to advance the clock more than once within a single case today; see "Known gaps".

## Running test files programmatically

```ts
import { ComponentRegistry } from '@ferrule/runtime';
import { builtinOperators } from '@ferrule/operators';
import { builtinSources } from '@ferrule/sources'; // your own registry
import { builtinSinks } from '@ferrule/sinks';
import { runFerruleTests, renderHumanReport } from '@ferrule/testkit';

const registry = new ComponentRegistry().register(
  ...builtinSources(),
  ...builtinOperators(),
  ...builtinSinks(),
);

const summary = await runFerruleTests(['app.test.yaml'], { registry });
console.log(renderHumanReport(summary, { color: true }));
process.exitCode = summary.failed > 0 ? 1 : 0;
```

`runFerruleTests` combines every test file's pipeline `cases` with every distinct pipeline
config's inline `script` tests (deduplicated by config path) into one `ReportSummary`. Lower-level
pieces are exported too: `loadTestFile` (parse + validate one file), `runTestFile`/`runTestFiles`
(pipeline cases only), `discoverScriptTransforms`/`runInlineScriptTests` (inline tests only).

## Inline script tests

A `type: script` transform's `source` (or `file`) can contain `test { ... }` blocks
(`docs/language/design.md` §7). `discoverScriptTransforms(loadedConfig)` finds every `script`-typed
transform in a loaded pipeline config by convention (the component's declared `type` and its
`source`/`file` option — `@ferrule/testkit` does not depend on `@ferrule/operators`, so this is the
only way it can recognise one), and `runInlineScriptTests(discovered)` compiles and runs each
one's tests via `@ferrule/script`'s own `runInlineTests`. A script that fails to compile is
reported as its own failure (`compileError`, a rendered code frame) rather than throwing.

## Reporters

All three take a `ReportSummary` (`summarize(cases)`, or the one `runFerruleTests` already
returns):

- **`renderHumanReport(summary, { color? })`** — grouped by suite (test file path, or component ID
  for inline tests), a ✓/✗ per case, indented failure messages, a final `N/M passed` line.
- **`renderJunitReport(summary, suiteName?)`** — well-formed, escaped JUnit XML
  (`<testsuites><testsuite><testcase>`), for CI integrations that consume that format.
- **`renderJsonReport(summary, pretty?)`** / **`toJsonReport(summary)`** — a stable, plain JSON
  shape (`{ total, passed, failed, cases: [{ suite, name, kind, passed, messages }] }`).

## Component harnesses

For a plugin author testing one component in isolation (not a whole pipeline), wrapping
`@ferrule/runtime`'s own `createTest*Context` helpers with schema validation and finalizer-leak
detection:

```ts
import { testTransform, log } from '@ferrule/testkit';
import { myTransform } from './my-transform.js';

const result = await testTransform(myTransform, { threshold: 10 }, [log({ n: 5 }), log({ n: 20 })]);
// result.pushed: every event pushed, in order, with its port
// result.status: the combined delivery status of the input batch
```

- **`testTransform(definition, rawOptions, events, options?)`** — validates `rawOptions` against
  `definition.options`, runs `process()`/`flush()`, and throws if any input event was neither
  pushed onward nor had its finalizer finished (a **finalizer leak** — see
  `packages/runtime/README.md`'s "every event's finalizers must be finished"). Pushed events are
  finished `delivered` automatically (`finishPushed: 'none'` to finish them yourself instead) so
  `result.status` is deterministic without a real sink downstream.
- **`testSource(definition, rawOptions, driver, harnessOptions?)`** — builds and starts the
  source, hands the running harness to `driver` (advance the clock, wait, call `harness.abort()`),
  and resolves once `run()` returns.
- **`testSink(definition, rawOptions, events, harnessOptions?)`** — feeds `events`, closes the
  input, and awaits both `run()` and every event's finalizer finishing, with a leak **timeout**
  (unlike `testTransform`'s synchronous check, a sink that returns from `run()` without finishing
  an event would otherwise hang this call forever).
- **`assertPortOrder(pushed, expectedPorts)`** — an ordering assertion for `testTransform`'s
  `pushed` list.

## Event builders

`log(fields?, metadata?)`, `counter(name, value, options?)`, `gauge(name, value, options?)`,
`metricSet(name, values, options?)`, `distribution(name, samples, options?)`,
`histogram(name, buckets, count, sum, options?)`, `summary(name, quantiles, count, sum, options?)`,
`span(name, options?)` — small, ergonomic constructors over `@ferrule/core`'s event classes, used
throughout this package and directly usable from a hand-written Vitest test.

## Value-diff assertion helpers

`diffValues(expected, actual, mode)` (`'diff.ts'`) is the same value-level, path-reporting diff the
test-file runner uses for `outputs.<sink>.events`, built on `@ferrule/core`'s `valuesEqual`/
`formatValue`. `matchers.ts` wraps it as plain assertion functions for a hand-written test (no
`expect.extend` registration, so this package never depends on a particular Vitest version just
for its matcher types):

```ts
import { assertEventMatches, containsEventMatching, log } from '@ferrule/testkit';

assertEventMatches(myEvent, { status: 200 }); // throws a formatted diff on mismatch
containsEventMatching(events, { status: 200 }); // boolean, for a plain expect(...).toBe(true)
```

## Known gaps

- **`inputs`' raw-string form is always a log event's `message`**, not decoded through the real
  source's codec — this package has no dependency on `@ferrule/codecs` and no way to know which
  codec a given source `type` would use even if it did. A source-specific decode hook is a natural
  follow-up.
- **`outputs` only addresses sinks**, not an arbitrary transform port — wire the port you care
  about to a dedicated sink in the pipeline config under test (exactly as a real deployment would
  need to route it somewhere to observe it).
- **`advance_clock` runs once per case**, after all inputs are sent. There's no way to interleave
  further input batches with further clock advances within one case; write separate cases (or use
  `runTestFile`'s lower-level pieces directly) for a scenario that needs that.
- **`conditions` only evaluate against log events**, matching `@ferrule/script`'s own "logs only"
  execution model (see that package's README).
- **A route/filter-style transform's condition compile errors report positions against a synthetic
  wrapper**, not `conditions[i]` alone — this only affects `@ferrule/testkit`'s own
  `scriptCondition.ts` helper (used for `outputs.<sink>.conditions`), which, unlike
  `@ferrule/operators`'s `filter`/`route`, does not wrap with `?? fallback` — a fallible condition
  is a compile error here, not a silently-defaulted runtime value, since a test author should
  handle fallibility explicitly (`to_bool(.enabled) ?? false`) rather than have it hidden.
