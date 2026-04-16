import type { LogEvent } from '@ferrule/core';
import type { Span } from '../syntax/source.js';

/**
 * Why an `abort` outcome happened, as a structured field a caller can switch on instead of
 * pattern-matching {@link Outcome}'s `abort.reason` text (which is for humans and may change):
 *
 * - `abort` — a deliberate `abort`/`abort "reason"`, an unhandled `!` on a `Failure`, or an
 *   `any`-typed operator seeing operands of a kind it cannot work with at runtime. This is the
 *   only cause a well-formed program can trigger through ordinary control flow.
 * - `limit` — a resource limit (`runtime/limits.ts`) was exceeded.
 * - `internal` — a genuine bug: either the compiled program's own execution threw something that
 *   isn't a recognised {@link Outcome}-producing signal (`ScriptBugError` or an unexpected JS
 *   error), i.e. `@ferrule/script` itself, or something it calls into, misbehaved.
 */
export type AbortCause = 'abort' | 'limit' | 'internal';

/**
 * What running a compiled program on one event produced (design.md §1 and §6).
 *
 * - `continue` — the event (possibly modified) continues, along with any events `emit()` added.
 *   `events[0]` is always the original (mutated) input event.
 * - `drop` — `drop` ran; the event is discarded, silently and countably.
 * - `abort` — the event failed irrecoverably (an unhandled `!`, an explicit `abort`, an `any`
 *   operator type mismatch, or a resource limit) and should go to the component's error output.
 *   `cause` tells a deliberate abort/mismatch apart from a resource-limit or genuine bug; `reason`
 *   is the human-readable message (its text, including any `limit exceeded: `/`internal error: `
 *   prefix, may change — match on `cause`, not on `reason`'s content).
 */
export type Outcome =
  | { readonly kind: 'continue'; readonly events: readonly LogEvent[] }
  | { readonly kind: 'drop' }
  | {
      readonly kind: 'abort';
      readonly reason: string;
      readonly span: Span;
      readonly cause: AbortCause;
    };
