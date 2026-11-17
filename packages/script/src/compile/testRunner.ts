import {
  LogEvent,
  MetricEvent,
  valuesEqual,
  type MetricValue,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import {
  createRunCtx,
  RateLimiter,
  type Frame,
  type RuntimeValue,
  type ScriptEvent,
} from '../runtime/context.js';
import { metricToValue, setMetricField } from '../runtime/metricAccess.js';
import type { Outcome } from '../runtime/outcome.js';
import { abortSignal } from '../runtime/signal.js';
import type { TestDecl } from '../syntax/ast.js';
import type { Span } from '../syntax/source.js';
import { Compiler } from './compiler.js';
import type { AnyCompiledProgram, CompiledProgram } from './program.js';
import { outcomeForError } from './program.js';
import { CompileScope } from './scope.js';

/** One field of a test's `expect` block that did not match the actual result. */
export interface FieldDiff {
  readonly path: string;
  readonly expected: Value;
  readonly actual: Value | undefined;
}

export interface InlineTestResult {
  readonly name: string;
  readonly passed: boolean;
  /** Non-empty only when the run continued but its fields disagreed with `expect`. */
  readonly diffs: readonly FieldDiff[];
  /** The full outcome of running the transform on `given`, for inspecting an unexpected drop/abort. */
  readonly outcome: Outcome<ScriptEvent>;
}

/**
 * Runs every `test { given { ... } expect { ... } }` block in a compiled program (design.md §7).
 *
 * `given` and `expect` are evaluated standalone — a fresh frame with none of the transform's own
 * `let`-bound variables in scope, so they may use literals, arrays/objects, string interpolation,
 * and pure builtin calls (`now()`, `to_int(...)`, ...), but not references to the transform's own
 * `let`s. This matches every example in design.md and the checker's own test fixtures, which
 * write `given`/`expect` as plain object literals; supporting the transform's local variables
 * inside a test block as well would need running the transform's own statements up to the test's
 * source position and is left to a later milestone (see the package README's "Known gaps").
 *
 * Comparison is a *partial* match: every field named in `expect` must equal the corresponding
 * field of the resulting event (after running the whole program on an event built from `given`);
 * fields `expect` does not mention are ignored, so a test can check only what it cares about.
 */
export function runInlineTests(program: AnyCompiledProgram): readonly InlineTestResult[] {
  return program.tests.map((test) => runOneTest(test, program));
}

/**
 * Builds the event a metric test runs against from its `given` block. `type` picks the
 * `MetricValue` shape — zero-valued, so a test only states the parts it cares about — and every
 * other key goes through the same validating setters a program's own writes use
 * (`runtime/metricAccess.ts`), so a fixture cannot describe a metric a script could not produce.
 * The checker (E314) already requires `name` and `type`; this re-checks because `runInlineTests`
 * is reachable with any `CheckResult`, including one whose diagnostics a caller ignored.
 */
function zeroMetricValueOfType(type: Value | undefined, span: Span): MetricValue {
  switch (type) {
    case 'counter':
      return { type: 'counter', value: 0 };
    case 'gauge':
      return { type: 'gauge', value: 0 };
    case 'set':
      return { type: 'set', values: new Set() };
    case 'distribution':
      return { type: 'distribution', samples: [], statistic: 'histogram' };
    case 'histogram':
      return { type: 'histogram', buckets: [], count: 0, sum: 0 };
    case 'summary':
      return { type: 'summary', quantiles: [], count: 0, sum: 0 };
    default:
      throw abortSignal(
        `a metric test's \`given\` must set 'type' to one of "counter", "gauge", "set", "distribution", "histogram", or "summary"`,
        span,
      );
  }
}

function buildMetricFromGiven(given: ValueMap, span: Span): MetricEvent {
  const name = given.get('name');
  if (typeof name !== 'string') {
    throw abortSignal("a metric test's `given` must set 'name' to a string", span);
  }
  const metric = new MetricEvent({
    name,
    kind: 'absolute',
    value: zeroMetricValueOfType(given.get('type'), span),
  });
  for (const [key, value] of given) {
    // `name` and `type` are consumed above: `type` is read-only once the metric exists, and
    // `name` is already set (re-applying it is harmless but pointless).
    if (key === 'name' || key === 'type') continue;
    setMetricField(metric, key, value, span);
  }
  return metric;
}

function runOneTest(test: TestDecl, program: AnyCompiledProgram): InlineTestResult {
  const compiler = new Compiler(
    program.checkResult,
    program.implementations,
    undefined,
    program.target,
  );
  const scope = new CompileScope(compiler.alloc);
  const givenEval = compiler.compileHandled(test.given, scope);
  const expectEval = compiler.compileHandled(test.expect, scope);
  const frame: Frame = new Array<RuntimeValue>(compiler.alloc.slotCount).fill(null);
  // `given`/`expect` are plain expressions over literals, so the event in this context is only a
  // placeholder — neither block may read the event being transformed.
  const ctx = createRunCtx(new LogEvent(), undefined, new RateLimiter(0), test.span);

  let given: Value;
  let expect: Value;
  let outcome: Outcome<ScriptEvent>;
  try {
    given = givenEval(frame, ctx) as Value;
    expect = expectEval(frame, ctx) as Value;
    outcome =
      program.target === 'metric'
        ? (program as CompiledProgram<MetricEvent>).run(
            buildMetricFromGiven(given as ValueMap, test.span),
          )
        : (program as CompiledProgram<LogEvent>).run(new LogEvent(given as ValueMap));
  } catch (error) {
    return {
      name: test.name,
      passed: false,
      diffs: [],
      outcome: outcomeForError(error, test.span),
    };
  }

  if (outcome.kind !== 'continue') {
    return { name: test.name, passed: false, diffs: [], outcome };
  }

  const result = outcome.events[0]!;
  // A metric is compared through the same projection a script reads (`.name`, `.value`, ...), so
  // `expect` names exactly the fields the program itself writes.
  const actualFields = result instanceof MetricEvent ? metricToValue(result) : result.fields;
  const expectedFields = expect as ValueMap;
  const diffs: FieldDiff[] = [];
  for (const [key, expected] of expectedFields) {
    const actual = actualFields.get(key);
    if (actual === undefined || !valuesEqual(actual, expected)) {
      diffs.push({ path: key, expected, actual });
    }
  }
  return { name: test.name, passed: diffs.length === 0, diffs, outcome };
}
