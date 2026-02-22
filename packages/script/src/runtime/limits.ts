import type { Span } from '../syntax/source.js';
import { limitSignal } from './signal.js';

/**
 * Per-event resource limits (design.md §6). Every compiled program enforces these while it runs
 * one event; exceeding any of them aborts the event with a `kind: 'limit'` reason rather than
 * letting the program consume unbounded memory or time.
 */
export interface ResourceLimits {
  /** Maximum number of events `emit()` may add beyond the (possibly dropped) input event. */
  readonly maxEmittedEvents: number;
  /** Maximum length (UTF-16 code units) of a string produced by concatenation or interpolation. */
  readonly maxStringLength: number;
  /** Maximum element/entry count of an array or object produced by a standard library function. */
  readonly maxCollectionSize: number;
  /** Maximum input length (UTF-16 code units) passed to a regex match/replace/split operation. */
  readonly maxRegexInputLength: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  maxEmittedEvents: 64,
  maxStringLength: 1_000_000,
  maxCollectionSize: 100_000,
  maxRegexInputLength: 1_000_000,
};

export function resolveLimits(overrides?: Partial<ResourceLimits>): ResourceLimits {
  return overrides === undefined ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, ...overrides };
}

export function checkStringLength(length: number, limits: ResourceLimits, span: Span): void {
  if (length > limits.maxStringLength) {
    throw limitSignal(
      `string of length ${length} exceeds the maximum string length (${limits.maxStringLength})`,
      span,
    );
  }
}

export function checkCollectionSize(size: number, limits: ResourceLimits, span: Span): void {
  if (size > limits.maxCollectionSize) {
    throw limitSignal(
      `collection of size ${size} exceeds the maximum collection size (${limits.maxCollectionSize})`,
      span,
    );
  }
}

export function checkRegexInputLength(length: number, limits: ResourceLimits, span: Span): void {
  if (length > limits.maxRegexInputLength) {
    throw limitSignal(
      `regex input of length ${length} exceeds the maximum regex input length (${limits.maxRegexInputLength})`,
      span,
    );
  }
}

export function checkEmittedEvents(count: number, limits: ResourceLimits, span: Span): void {
  if (count > limits.maxEmittedEvents) {
    throw limitSignal(
      `emit() produced more than the maximum number of extra events (${limits.maxEmittedEvents})`,
      span,
    );
  }
}
