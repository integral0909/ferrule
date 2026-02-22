import type { LogEvent } from '@ferrule/core';
import type { Span } from '../syntax/source.js';

/**
 * What running a compiled program on one event produced (design.md §1 and §6).
 *
 * - `continue` — the event (possibly modified) continues, along with any events `emit()` added.
 *   `events[0]` is always the original (mutated) input event.
 * - `drop` — `drop` ran; the event is discarded, silently and countably.
 * - `abort` — the event failed irrecoverably (an unhandled `!`, an explicit `abort`, an `any`
 *   operator type mismatch, or a resource limit) and should go to the component's error output.
 */
export type Outcome =
  | { readonly kind: 'continue'; readonly events: readonly LogEvent[] }
  | { readonly kind: 'drop' }
  | { readonly kind: 'abort'; readonly reason: string; readonly span: Span };
