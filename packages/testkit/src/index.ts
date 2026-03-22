/**
 * `@ferrule/testkit` — utilities for testing Ferrule pipelines and custom components: a YAML
 * pipeline test-file runner (`ferrule test`), inline `script` test-block discovery, human/JUnit/
 * JSON reporters, component test harnesses (`testSource`/`testTransform`/`testSink`), event
 * builders, and value-diff assertion helpers. See `README.md` for the test-file format reference.
 */

export {
  log,
  counter,
  gauge,
  metricSet,
  distribution,
  histogram,
  summary,
  span,
} from './events.js';
export type { MetricOptions, SpanOptions } from './events.js';

export {
  diffValues,
  eventToValue,
  formatDiff,
  formatDiffs,
  type FieldDiff,
  type MatchMode,
} from './diff.js';

export {
  assertEventMatches,
  assertEveryEventMatches,
  containsEventMatching,
  diffEvent,
} from './matchers.js';

export {
  assertPortOrder,
  testSink,
  testSource,
  testTransform,
  type CapturedLogRecord,
  type PushedEvent,
  type SentBatch,
  type TestContextOptions,
  type TestSinkHarness,
  type TestSinkResult,
  type TestSourceHarness,
  type TestSourceResult,
  type TestTransformHarness,
  type TestTransformOptions,
  type TestTransformResult,
} from './harness.js';

export {
  compileCondition,
  evaluateCondition,
  E_CONDITION_COMPILE,
  type ConditionResult,
} from './scriptCondition.js';

export {
  outputExpectationSchema,
  testCaseSchema,
  testFileSchema,
  type OutputExpectation,
  type TestCase,
  type TestFile,
} from './testfile/schema.js';
export { eventFromInputSpec } from './testfile/eventSpec.js';
export { loadTestFile, renderLoadError, type LoadedTestFile } from './testfile/loader.js';
export {
  loadPipelineConfig,
  runTestFile,
  runTestFiles,
  type CaseFailure,
  type CaseResult,
  type PipelineTestOptions,
  type TestFileResult,
} from './testfile/runner.js';
export {
  discoverScriptTransforms,
  runInlineScriptTests,
  type DiscoveredScript,
  type InlineScriptTestOutcome,
} from './testfile/inlineScripts.js';

export { runFerruleTests, type RunSuiteOptions } from './suite.js';

export {
  inlineScriptReportCases,
  pipelineReportCases,
  summarize,
  type ReportCase,
  type ReportCaseKind,
  type ReportSummary,
} from './reporters/types.js';
export { renderHumanReport, type HumanReportOptions } from './reporters/human.js';
export { renderJunitReport } from './reporters/junit.js';
export { renderJsonReport, toJsonReport, type JsonReport } from './reporters/json.js';
