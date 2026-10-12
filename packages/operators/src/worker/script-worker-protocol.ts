import type { AbortCause, ResourceLimits } from '@ferrule/script';
import type { FieldKindName } from '../util/inputSchema.js';

/**
 * Wire protocol between the `script` transform (`../script.ts`) and `script-worker-entry.ts`,
 * built on `@ferrule/runtime`'s generic `WorkerPool`. See `packages/operators/README.md`'s
 * "Worker pool (CPU-heavy `script`)" for the full design; summary:
 *
 * - **Request payload**: an `@ferrule/buffer`-encoded batch of the chunk's `LogEvent`s. No
 *   request `meta` is needed — the payload alone is enough for the worker to do its work.
 * - **Response payload**: one `@ferrule/buffer`-encoded batch, concatenating, per original event
 *   *in order*: for `continue`, its (possibly mutated) primary event followed by every `emit()`
 *   extra; for `abort`, just its mutated-up-to-the-abort-point primary event; for `drop`,
 *   nothing. `ScriptWorkerOutcome.extraCount` is what lets the main thread (which cannot tell
 *   events apart by content alone) split this flat sequence back up per original event.
 * - **Response meta**: `outcomes`, one entry per original input event, in order — everything the
 *   main thread needs that the event codec itself doesn't carry: the outcome kind, and for
 *   `abort`, the failure's `reason`/`span`/`cause` (there is no `Outcome`-level data for `drop`,
 *   and `continue` needs only `extraCount` to know how many trailing events in the payload are
 *   its own `emit()` extras).
 */

export interface ScriptWorkerInit {
  readonly source: string;
  readonly fileName: string;
  readonly inputSchema: ReadonlyMap<string, FieldKindName> | undefined;
  readonly limits: Partial<ResourceLimits>;
}

export type ScriptWorkerOutcome =
  | { readonly kind: 'continue'; readonly extraCount: number }
  | { readonly kind: 'drop' }
  | {
      readonly kind: 'abort';
      readonly reason: string;
      readonly span: { readonly start: number; readonly end: number };
      readonly cause: AbortCause;
    };

export interface ScriptWorkerResponseMeta {
  readonly outcomes: readonly ScriptWorkerOutcome[];
}
