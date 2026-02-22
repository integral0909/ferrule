/**
 * Rough throughput benchmark for the Ferrule Script compiler/runtime.
 *
 * Run with:
 *   node --experimental-strip-types packages/script/bench/throughput.ts
 * or, from inside the monorepo where tsx/vitest are available:
 *   pnpm exec tsx packages/script/bench/throughput.ts
 *
 * Not part of CI — see the package README's "Benchmark" section.
 */
import { LogEvent } from '@ferrule/core';
import { compile, parseAndCheck } from '@ferrule/script';

const PROGRAM = `
.level = downcase(.level) ?? "info"
.message = trim(.message) ?? .message
.status_code = to_int(.status_code) ?? 0
.tags = filter(.tags, |t| is_string(t)) ?? []
.headers = map_values(.headers, |k, v| downcase(v) ?? v) ?? {}

if .status_code >= 500 {
  .severity = "critical"
} else if .status_code >= 400 {
  .severity = "warning"
} else {
  .severity = "ok"
}

match .level {
  "error" => { .alert = true },
  "warn" => { .alert = false },
  _ => { .alert = false },
}
`;

function sampleEvent(i: number): LogEvent {
  return LogEvent.from({
    level: i % 3 === 0 ? 'WARN' : i % 5 === 0 ? 'ERROR' : 'info',
    message: `  request ${i} handled in ${i % 100}ms  `,
    status_code: String(200 + (i % 5) * 100),
    tags: ['a', 1, 'b', null, 'c'],
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': String(i) },
  });
}

function bench(name: string, run: () => void, iterations: number): void {
  // Warm up the JIT before measuring.
  for (let i = 0; i < Math.min(1000, iterations); i++) run();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) run();
  const elapsedMs = performance.now() - start;
  const perSecond = (iterations / elapsedMs) * 1000;
  // eslint-disable-next-line no-console -- a benchmark script's whole job is printing results
  console.log(
    `${name.padEnd(28)} ${iterations.toString().padStart(9)} events in ${elapsedMs.toFixed(1).padStart(9)} ms` +
      `  (${Math.round(perSecond).toLocaleString()} events/sec)`,
  );
}

function main(): void {
  const checked = parseAndCheck(PROGRAM);
  const errors = [...checked.parseDiagnostics, ...checked.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    throw new Error(`benchmark program has errors: ${errors.map((d) => d.message).join('; ')}`);
  }

  const optimized = compile(checked, { optimize: true });
  const unoptimized = compile(checked, { optimize: false });

  const iterations = 200_000;
  let i = 0;
  bench('compiled (optimized)', () => optimized.run(sampleEvent(i++)), iterations);
  i = 0;
  bench('compiled (unoptimized)', () => unoptimized.run(sampleEvent(i++)), iterations);

  // A trivial program isolates per-event fixed overhead (frame allocation, context setup) from
  // the cost of the standard library calls above.
  const trivialChecked = parseAndCheck('.seen = true');
  const trivial = compile(trivialChecked);
  i = 0;
  bench('trivial program', () => trivial.run(sampleEvent(i++)), iterations);
}

main();
