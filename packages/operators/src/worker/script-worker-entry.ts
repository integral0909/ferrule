/**
 * Worker entry for the `script` transform's `workers: <n>` option. Run inside a `worker_threads`
 * worker started by `@ferrule/runtime`'s `WorkerPool` (see `../script.ts` and
 * `script-worker-protocol.ts`), via `resolveWorkerEntry`/`runWorkerPoolHandler` — see
 * `packages/runtime/README.md`'s "Worker pool" section for why this is always the *built*
 * `dist/worker/script-worker-entry.js`, never the TypeScript source directly: a relative import
 * from this file (`../util/inputSchema.js`, a few lines down) resolves by file path alone, with
 * none of the `package.json` `exports`-condition trickery that lets a *bare* `@ferrule/*` import
 * switch between `dist/` and `src/` — so unless this file itself is compiled, that sibling
 * import (and every other `@ferrule/*` package's own internal relative imports, transitively)
 * has nothing to resolve to.
 *
 * A compiled `@ferrule/script` program is a tree of closures, which cannot cross a
 * `worker_threads` boundary at all (closures aren't structured-clonable, let alone the compact
 * binary form the rest of this pipeline uses for events). So instead of trying to ship the
 * compiled program, each worker gets the *source text* once as `workerData` and compiles its own
 * copy — once per worker, not per batch. The main thread already compiled (and type-checked) the
 * exact same source at build time (`script.ts`'s `build`), so a compile failure here would mean
 * `@ferrule/script` behaved non-deterministically between the two compiles, which is a bug, not
 * a data problem — it is allowed to fail the worker (and thus, via `WorkerPool`'s crash handling,
 * the batch) rather than being reported as a normal `Outcome`.
 */
import { decodeEventBatch, encodeEventBatch } from '@ferrule/buffer';
import { isLogEvent, type LogEvent } from '@ferrule/core';
import { runWorkerPoolHandler } from '@ferrule/runtime';
import {
  compile,
  parseAndCheck,
  SourceFile,
  type CompiledProgram,
  type Type,
} from '@ferrule/script';
import { workerData } from 'node:worker_threads';
import { inputSchemaType } from '../util/inputSchema.js';
import type {
  ScriptWorkerInit,
  ScriptWorkerOutcome,
  ScriptWorkerResponseMeta,
} from './script-worker-protocol.js';

function compileFromInit(init: ScriptWorkerInit): CompiledProgram {
  const file = new SourceFile(init.fileName, init.source);
  const inputSchema: Type | undefined = inputSchemaType(init.inputSchema);
  const result = parseAndCheck(file, inputSchema === undefined ? {} : { inputSchema });
  const errors = [...result.parseDiagnostics, ...result.diagnostics].filter(
    (d) => d.severity === 'error',
  );
  if (errors.length > 0) {
    throw new Error(
      'script worker failed to compile a program the main thread already validated: ' +
        errors.map((d) => d.message).join('; '),
    );
  }
  return compile(result);
}

const init = workerData as ScriptWorkerInit;
const program = compileFromInit(init);

runWorkerPoolHandler<undefined, ScriptWorkerResponseMeta>((_meta, payload) => {
  const events = decodeEventBatch(payload);
  const outcomes: ScriptWorkerOutcome[] = [];
  const outputEvents: LogEvent[] = [];

  for (const event of events) {
    if (!isLogEvent(event)) {
      // `script.ts` never sends a metric/span event to a worker (they pass through untouched on
      // the main thread, same as the in-thread path) — a non-log event here is a bug on the
      // caller's side, not data this worker can route anywhere sensible.
      throw new Error(`script worker received a non-log event (kind: ${event.kind})`);
    }
    // No `clock` override: this falls back to `Timestamp.now()` (the real wall clock), unlike
    // the in-thread path, which uses `ctx.clock` (deterministic in tests). Threading a
    // `ManualClock`'s reading across the thread boundary isn't worth it for CPU-bound work, so a
    // program whose result depends on `now()` can observe a different (but still real) moment
    // per chunk when run with `workers > 0` — see `packages/operators/README.md`.
    const outcome = program.run(event, { limits: init.limits });
    switch (outcome.kind) {
      case 'continue': {
        const [first, ...extra] = outcome.events;
        outputEvents.push(first ?? event);
        for (const extraEvent of extra) outputEvents.push(extraEvent);
        outcomes.push({ kind: 'continue', extraCount: extra.length });
        break;
      }
      case 'drop':
        outcomes.push({ kind: 'drop' });
        break;
      case 'abort':
        // The mutated-up-to-the-abort-point event travels back too, so the main thread can
        // attach `ferrule.error.*` to the same field state the in-thread path would have.
        outputEvents.push(event);
        outcomes.push({
          kind: 'abort',
          reason: outcome.reason,
          span: outcome.span,
          cause: outcome.cause,
        });
        break;
    }
  }

  return { meta: { outcomes }, payload: encodeEventBatch(outputEvents) };
});
