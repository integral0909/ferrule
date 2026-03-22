import { s, type Infer } from '@ferrule/schema';

/**
 * The `ferrule test` pipeline test-file format: named cases against one pipeline config, each
 * injecting events at named sources and asserting on what named sinks collect. See
 * `packages/testkit/README.md` for the full reference with examples; this module is just the
 * `@ferrule/schema` shape (validated by `loader.ts` after YAML parsing) and its inferred types.
 */

const matchModeSchema = s.enum(['exact', 'subset'] as const);

export const outputExpectationSchema = s.object({
  /** How `events` compares to what the sink actually collected. Default `subset`. */
  match: matchModeSchema.default('subset'),
  /** Exact expected count of events collected at this sink. */
  count: s.integer({ min: 0 }).optional(),
  /** Shorthand for `count: 0`. */
  none: s.boolean().optional(),
  /**
   * Expected events, compared positionally (`events[i]` against the `i`th collected event) using
   * `match`. A JSON/YAML object is a log event's fields by default; see the README for the
   * `kind: metric`/`kind: span` structured forms.
   */
  events: s.array(s.unknown()).optional(),
  /** Ferrule Script boolean expressions, each evaluated against every event this sink collected. */
  conditions: s.array(s.string({ minLength: 1 })).optional(),
});

export type OutputExpectation = Infer<typeof outputExpectationSchema>;

export const testCaseSchema = s.object({
  name: s.string({ minLength: 1 }),
  description: s.string().optional(),
  /** Component ID (a source in the pipeline config) -> events to inject there, in order. */
  inputs: s.record(s.array(s.unknown())).default(new Map()),
  /** Component ID (a sink in the pipeline config) -> expectation. */
  outputs: s.record(outputExpectationSchema).default(new Map()),
  /**
   * Advances the test's `ManualClock` by this many milliseconds after every input is sent and
   * before the pipeline is drained, so a tick-interval transform (`aggregate`, `window_reduce`,
   * ...) gets a chance to fire. Omit for no advance.
   */
  advance_clock: s.duration().optional(),
});

export type TestCase = Infer<typeof testCaseSchema>;

export const testFileSchema = s.object({
  /** Path to the pipeline config under test, resolved relative to this test file. */
  config: s.string({ minLength: 1 }),
  description: s.string().optional(),
  cases: s.array(testCaseSchema, { minItems: 1 }),
});

export type TestFile = Infer<typeof testFileSchema>;
