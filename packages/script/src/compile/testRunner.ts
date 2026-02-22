import { LogEvent, valuesEqual, type Value, type ValueMap } from '@ferrule/core';
import { createRunCtx, RateLimiter, type Frame, type RuntimeValue } from '../runtime/context.js';
import type { Outcome } from '../runtime/outcome.js';
import type { TestDecl } from '../syntax/ast.js';
import { Compiler } from './compiler.js';
import type { CompiledProgram } from './program.js';
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
  readonly outcome: Outcome;
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
export function runInlineTests(program: CompiledProgram): readonly InlineTestResult[] {
  return program.tests.map((test) => runOneTest(test, program));
}

function runOneTest(test: TestDecl, program: CompiledProgram): InlineTestResult {
  const compiler = new Compiler(program.checkResult, program.implementations);
  const scope = new CompileScope(compiler.alloc);
  const givenEval = compiler.compileHandled(test.given, scope);
  const expectEval = compiler.compileHandled(test.expect, scope);
  const frame: Frame = new Array<RuntimeValue>(compiler.alloc.slotCount).fill(null);
  const ctx = createRunCtx(new LogEvent(), undefined, new RateLimiter(0), test.span);

  let given: Value;
  let expect: Value;
  try {
    given = givenEval(frame, ctx) as Value;
    expect = expectEval(frame, ctx) as Value;
  } catch (error) {
    const outcome = outcomeForError(error, test.span);
    return { name: test.name, passed: false, diffs: [], outcome };
  }

  const event = new LogEvent(given as ValueMap);
  const outcome = program.run(event);
  if (outcome.kind !== 'continue') {
    return { name: test.name, passed: false, diffs: [], outcome };
  }

  const actualFields = outcome.events[0]!.fields;
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
